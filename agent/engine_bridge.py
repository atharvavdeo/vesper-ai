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

    def recall(self, query: str, limit: int = 5) -> dict:
        """Project memory: FTS over doc_chunks + this project's past field observations."""
        q = (query or "").strip()
        out: dict = {"query": q, "project_notes": [], "past_observations": []}
        if not q:
            return out
        fts_q = " OR ".join(w for w in q.replace('"', " ").split() if len(w) > 2) or q
        try:
            rows = self.repo._all(
                "SELECT doc_type, doc_ref, substr(content,1,240) AS snippet "
                "FROM doc_chunks_fts WHERE doc_chunks_fts MATCH ? LIMIT ?", (fts_q, limit))
            out["project_notes"] = rows
        except Exception:
            pass
        try:
            out["past_observations"] = self.repo._all(
                "SELECT observation_id, created_at, location_id, element, attribute, value_claimed, "
                "unit, drawing_id, final_decision, contradiction_kinds "
                "FROM field_observations WHERE project_id = ? "
                "AND (location_id LIKE ? OR attribute LIKE ? OR spoken_text LIKE ?) "
                "ORDER BY created_at DESC LIMIT ?",
                (self.repo.project_id, f"%{q}%", f"%{q}%", f"%{q}%", limit))
        except Exception:
            pass
        return out

    def decide(self, decision: str) -> dict:
        """decision: log_observation | raise_rfi | raise_ncr | stop_work | cancel."""
        if decision in ("log_observation", "raise_rfi", "raise_ncr", "stop_work") and not self.speaker_ok:
            return {"refused": True,
                    "reason": f"speaker not verified as the enrolled site manager "
                              f"(score {self.speaker_score:.2f}); logging is locked"
                              if self.speaker_score is not None else
                              "speaker not verified as the enrolled site manager; logging is locked"}
        return _compact(self._dlg.handle(text="", decision=decision))
