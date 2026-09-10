"""vesper-ai real-time voice agent (LiveKit).

Full-duplex: continuous mic, streaming STT (Groq Whisper), grounded LLM, Rime TTS,
silero VAD + barge-in. The LLM may ONLY speak facts returned by the engine tools.

Run:  ./run.sh   (or: .venv/bin/python worker.py dev)
"""
from __future__ import annotations

import json
import logging
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(REPO_ROOT / ".env")
# Keep local provider credentials out of tracked files. The backend already uses
# this override; loading it here keeps the LiveKit worker on the same providers.
load_dotenv(REPO_ROOT / "backend" / ".env.local", override=True)

from livekit.agents import (  # noqa: E402
    Agent, AgentSession, JobContext, RoomInputOptions, WorkerOptions, cli, function_tool,
)
from livekit.agents import RunContext  # noqa: E402
from livekit.plugins import groq, openai, rime, silero  # noqa: E402

from engine_bridge import Brain  # noqa: E402
from voiceprofile import VoiceProfiler  # noqa: E402

logger = logging.getLogger("vesper.agent")
logging.basicConfig(level=logging.INFO)

INSTRUCTIONS = """
You are Vesper, the QA/QC assistant for the site manager of this project. You have been on
this job the whole time and you remember it. Speak plain, natural ENGLISH — short, practical,
like an experienced colleague on the radio. Compose every sentence yourself; tools give you
STRUCTURED DATA, never a script to read out.

CONVERSATION STYLE:
- You already know this site (see SITE MEMORY below). Refer to past work naturally:
  "that's the same C-5 cage we released for pour on the eighth", "RFI fifty is still open".
- Be a colleague continuing yesterday's conversation, not a form. One question at a time.
- Keep replies under 3 sentences. Say numbers so they are easy to hear over noise
  ("one eighty millimetres", "R F I zero four seven", "A one oh two revision four").
- Never lecture. If nothing is wrong, say so briefly and move on.

HARD RULES (safety — never bend these):
- You may ONLY state drawing numbers, revisions, issue dates, RFI numbers, code clauses and
  measurements that come from SITE MEMORY or a tool result. NEVER invent or estimate a number.
- When the manager describes a field observation, call `check_observation` with their words
  (verbatim, uncorrected).
- EVERY completed manager turn must receive one spoken response. This includes a short
  clarification such as "E-1", "the stem thickness", "yes", or "go". For every site-detail
  turn, call `check_observation` first; never wait silently for the manager to repeat it.
- If the result has `contradictions` or `blockers`: in your own words say what is wrong,
  naming the latest drawing + revision + its issue date + the RFI that drove the change +
  the expected value and tolerance, all from the result. Then ask what they want to do —
  only the options in `allowed_decisions`.
- If the result is clean: read back what you understood in one line and ask if you should log it.
- If `missing` is non-empty: ask only for those specific fields. Do not log.
- Never say something is logged unless a tool result shows `logged`.
- Act on the manager's choice via `log_observation` / `raise_rfi` / `raise_ncr` /
  `stop_work` / `cancel`. If a tool returns `refused`, tell them the reason plainly.
- For anything historical not already in SITE MEMORY — an older inspection, a spec, a
  submittal, a past RFI — call `recall` and answer from what it returns.

SITE MEMORY (current state of this project — this is real, use it):
{site_brief}
"""


class VesperAgent(Agent):
    def __init__(self) -> None:
        brain = Brain()
        try:
            brief = brain.brief_text()
        except Exception as e:  # never let memory failure kill the session
            logger.warning("site brief unavailable: %s", e)
            brief = "(site memory unavailable — use the recall tool for any history)"
        super().__init__(instructions=INSTRUCTIONS.replace("{site_brief}", brief))
        self.brain = brain
        self.brief = brief

    async def _publish_state(self, ctx: RunContext, result: dict) -> None:
        """Push the structured engine result to the browser for the cards UI."""
        try:
            await ctx.session.room.local_participant.publish_data(
                json.dumps({"type": "engine", "result": result}).encode(),
                topic="vesper",
            )
        except Exception:
            pass

    @function_tool
    async def recall(self, ctx: RunContext, query: str) -> str:
        """Search project memory — past field observations, RFIs, specs, drawing notes, DPRs.

        Args:
            query: what to look up, e.g. "C-5 rebar", "RFI 47", "L4 slab pour", "last cover check".
        """
        result = self.brain.recall(query)
        return json.dumps(result, ensure_ascii=False)

    @function_tool
    async def check_observation(self, ctx: RunContext, utterance: str) -> str:
        """Run the manager's spoken observation through the deterministic engine.

        Args:
            utterance: the manager's words, verbatim and uncorrected.
        Returns a JSON string with: state, contradictions[], blockers[], missing[],
        resolved{location_id, drawing, fact{value,unit,tolerance,revision,issued_on,via_rfi,code_ref}},
        slots{}, allowed_decisions[], grounding_line, logged.
        """
        result = self.brain.observe(utterance)
        await self._publish_state(ctx, result)
        logger.info("check_observation -> %s", result.get("state"))
        return json.dumps(result, ensure_ascii=False)

    async def _decide(self, ctx: RunContext, decision: str) -> str:
        result = self.brain.decide(decision)
        if not result.get("refused"):
            await self._publish_state(ctx, result)
        logger.info("decision %s -> %s", decision, "refused" if result.get("refused") else result.get("state"))
        return json.dumps(result, ensure_ascii=False)

    @function_tool
    async def log_observation(self, ctx: RunContext) -> str:
        """Log the current observation to field_observations. Only after the contradiction
        (if any) was spoken and the manager asked to log."""
        return await self._decide(ctx, "log_observation")

    @function_tool
    async def raise_rfi(self, ctx: RunContext) -> str:
        """Raise an RFI (status Open) and log the linked observation."""
        return await self._decide(ctx, "raise_rfi")

    @function_tool
    async def raise_ncr(self, ctx: RunContext) -> str:
        """Raise an NCR — log the observation flagged for the QA team."""
        return await self._decide(ctx, "raise_ncr")

    @function_tool
    async def stop_work(self, ctx: RunContext) -> str:
        """Order work to stop (used when a permit or hold-point blocker is open)."""
        return await self._decide(ctx, "stop_work")

    @function_tool
    async def cancel(self, ctx: RunContext) -> str:
        """Discard the current observation without logging anything."""
        return await self._decide(ctx, "cancel")


def _llm():
    # Groq openai/gpt-oss-20b — fast, tool-calling, reasoning_effort=low for latency.
    # (meta/llama-3.3-* is EOL on NVIDIA and removed on Groq as of 2026.)
    if os.getenv("AGENT_LLM", "groq") == "nvidia" and _keyok("NVIDIA_API_KEY"):
        return openai.LLM(
            model=os.getenv("NVIDIA_LLM_MODEL", "nvidia/llama-3.1-nemotron-70b-instruct"),
            base_url=os.getenv("NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1"),
            api_key=os.getenv("NVIDIA_API_KEY"), temperature=0.3,
        )
    return openai.LLM(
        model=os.getenv("GROQ_LLM_MODEL", "openai/gpt-oss-20b"),
        base_url=os.getenv("GROQ_BASE_URL", "https://api.groq.com/openai/v1"),
        api_key=os.getenv("GROQ_API_KEY"),
        temperature=0.3,
        reasoning_effort="low",
    )


def _keyok(name: str) -> bool:
    v = os.getenv(name, "").strip()
    return bool(v) and not v.startswith("<")


# Whisper continues the STYLE of its prompt, so this is written as a sample site transcript
# rather than a word list — it biases decoding toward grid refs (C-5, B-4), drawing numbers
# (A-102, S-301), revisions (R4) and QA vocabulary. Measured: turns "drawing at 102" into
# "drawing A-102" and "C5" into "C-5", which is what the parser needs. ~150 ms slower than
# turbo and clearly more accurate on site vocabulary.
STT_PROMPT = (
    "Column line C-5, rebar spacing 180 millimetres, drawing A-102 revision R4. "
    "Cover at B-4 column is 40 millimetres per IS 456. Stirrup spacing at C-6 measured 220. "
    "Zone B Level 3 hot work permit HWP-0112, fire watch pending, stop work. "
    "L4 slab thickness 150 millimetres on S-301 revision R2, RFI-050 still open. "
    "Raise an NCR. Log the observation. D-3 column, M30 concrete, pre-pour hold point."
)


def _stt():
    return groq.STT(
        model=os.getenv("GROQ_STT_MODEL", "whisper-large-v3"),
        language="en",
        prompt=STT_PROMPT,
    )


def _tts():
    # English, low-latency. mistv3 streams faster than coda; websocket cuts first-audio delay.
    return rime.TTS(
        model="mistv3",
        speaker=os.getenv("RIME_SPEAKER_EN", "cove"),
        lang="eng",
        api_key=os.getenv("RIME_API_KEY"),
        use_websocket=True,
    )


async def entrypoint(ctx: JobContext) -> None:
    await ctx.connect()
    agent = VesperAgent()

    async def _publish(obj: dict) -> None:
        try:
            await ctx.room.local_participant.publish_data(
                json.dumps(obj).encode(), topic="vesper")
        except Exception:
            pass

    # live voice profiling (SpeechBrain via voiceid sidecar) -> gates the logging tools
    profiler = VoiceProfiler(agent.brain, on_update=_publish)
    profiler.attach(ctx.room)

    # push the site memory to the browser so the manager sees what the agent is working from
    try:
        await _publish({"type": "brief", "brief": agent.brain.site_brief()})
    except Exception:
        pass

    session = AgentSession(
        stt=_stt(),
        llm=_llm(),
        tts=_tts(),
        vad=silero.VAD.load(),
        user_away_timeout=1800.0,   # don't "forget" the manager after 15s of silence
    )
    await session.start(
        agent=agent,
        room=ctx.room,
        room_input_options=RoomInputOptions(close_on_disconnect=False),
    )
    ctx.add_shutdown_callback(profiler.aclose)
    await session.generate_reply(instructions=(
        "Greet the site manager in TWO short sentences, as a colleague picking up where you "
        "left off. First sentence: name the most recent day's work from SITE MEMORY and the "
        "single most pressing open item (a hold point, an unsatisfied permit check, or an "
        "open RFI) — be specific, use the real IDs. Second sentence: ask what they are "
        "looking at now. Do not list everything."
    ))


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
