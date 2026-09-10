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

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

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
You are Vesper, a QA/QC assistant for a construction site manager. Speak in plain, natural
ENGLISH, short and practical, like a knowledgeable colleague on a radio. Compose every
sentence yourself — the tools give you STRUCTURED DATA, never a script to read.

HARD RULES:
- You may ONLY state drawing numbers, revisions, issue dates, RFI numbers, code clauses and
  measurements that appear in a `check_observation` tool result. NEVER guess or recall a number.
- When the manager describes a field observation, call `check_observation` with their words
  (verbatim, uncorrected).
- If the result has `contradictions` or `blockers`: in your own words, say what is wrong,
  naming the latest drawing + revision + its issue date + the RFI that drove the change +
  the expected value and tolerance, all taken from the result. Then ask the manager what
  they want to do — only the options in `allowed_decisions`.
- If the result is clean (no contradictions/blockers/missing): read back what you understood
  in one short line and ask "Want me to log it?".
- If `missing` is non-empty: ask only for those specific fields. Do not log.
- Never say something is logged unless a tool result shows `logged`.
- Act on the manager's choice by calling `log_observation` / `raise_rfi` / `raise_ncr` /
  `stop_work` / `cancel`. If a tool returns `refused`, tell them the reason.
- Keep replies under 3 sentences. Say numbers clearly ("one eighty millimetres",
  "R F I zero four seven").
- If the manager asks about something earlier, a past inspection, an RFI, a spec, or "what
  did we log before", call `recall` and answer from what it returns.

Open with one short line: "Go ahead — what did you observe?"
"""


class VesperAgent(Agent):
    def __init__(self) -> None:
        super().__init__(instructions=INSTRUCTIONS)
        self.brain = Brain()

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


def _stt():
    return groq.STT(model=os.getenv("GROQ_STT_MODEL", "whisper-large-v3-turbo"), language="en")


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
    await session.generate_reply(instructions="Greet the manager in one short English line.")


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
