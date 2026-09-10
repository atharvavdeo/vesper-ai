"""Bridge from the LiveKit agent to the deterministic engine in backend/.

The tested engine (extract -> DB retrieval -> contradiction rules -> guarded state
machine -> safety-gated persist) is the source of truth. This wrapper runs it and
returns a COMPACT STRUCTURED result. The agent's LLM composes the spoken reply from
that structure — it never invents a fact, revision, RFI or decision.
"""
from __future__ import annotations

import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

import config  # noqa: E402
import db as dbmod  # noqa: E402
from engine.dialogue import DialogueSession  # noqa: E402

import memory  # noqa: E402


def _fact(c) -> dict | None:
    f = getattr(c, "fact", None)
    if not f:
        return None
    return {
        "value": f.get("value_num"), "unit": f.get("unit"), "tolerance": f.get("tolerance"),
        "revision": f.get("revision"), "issued_on": f.get("issued_on"),
        "via_rfi": f.get("via_rfi"), "code_ref": f.get("code_ref"),
        "drawing_number": f.get("drawing_number"),
    }


def _compact(turn: dict) -> dict:
    """Everything the LLM is allowed to speak from — and nothing else."""
    res = turn.get("resolved", {}) or {}
    return {
        "state": turn["state"],
        # The deterministic engine owns the demo-safe wording as well as the
        # safety decision.  Supplying it to the voice model prevents a
        # paraphrase from dropping a revision, tolerance, or available action.
        "spoken_reply": (turn.get("reply") or {}).get("text", ""),
        "contradictions": [{"kind": k["kind"], "detail": k["detail"], "evidence": k.get("evidence", {})}
                           for k in turn.get("contradictions", [])],
        "blockers": [{"kind": k["kind"], "detail": k["detail"], "evidence": k.get("evidence", {})}
                     for k in turn.get("blockers", [])],
        "missing": [{"detail": k["detail"]} for k in turn.get("missing", [])],
        "resolved": {
            "location_id": res.get("location_id"),
            "drawing": res.get("drawing_label"),
            "drawing_id": res.get("drawing_id"),
            "fact": res.get("fact"),
            "location_inferred": res.get("location_inferred"),
        },
        "slots": {k: v.get("value") for k, v in (turn.get("slots") or {}).items()},
        "allowed_decisions": turn.get("allowedDecisions", []),
        "logged": turn.get("logged"),
        "events": turn.get("events", []),
    }


class Brain:
    """One per LiveKit room. Holds the DialogueSession so slots accumulate across turns."""

    def __init__(self) -> None:
        self.repo = dbmod.Repo(dbmod.connect(), config.PROJECT_ID)
        self.session_id = dbmod.create_session(self.repo, "Site Manager (voice)")
        self._dlg = DialogueSession(self.repo, self.session_id, llm=None, persist_turns=True)
        self.speaker_ok = True          # updated by the voice-ID gate
        self.speaker_score: float | None = None

    def observe(self, utterance: str) -> dict:
        return _compact(self._dlg.handle(text=utterance or "", noise="none"))

    def site_brief(self) -> dict:
        """Structured situation report — what has already happened on this site."""
        return memory.site_brief(self.repo)

    def brief_text(self) -> str:
        """Prose form of the brief, for the agent's system prompt."""
        return memory.brief_text(self.site_brief())

    def recall(self, query: str, limit: int = 5) -> dict:
        """Search real project history (observations, DPRs, RFIs, submittals, permits,
        drawings) before the scraped template library."""
        return memory.recall(self.repo, query, limit)

    def decide(self, decision: str) -> dict:
        """decision: log_observation | raise_rfi | raise_ncr | stop_work | cancel."""
        if decision in ("log_observation", "raise_rfi", "raise_ncr", "stop_work") and not self.speaker_ok:
            return {"refused": True,
                    "reason": f"speaker not verified as the enrolled site manager "
                              f"(score {self.speaker_score:.2f}); logging is locked"
                              if self.speaker_score is not None else
                              "speaker not verified as the enrolled site manager; logging is locked"}
        return _compact(self._dlg.handle(text="", decision=decision))
