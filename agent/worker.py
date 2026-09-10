"""vesper-ai real-time voice agent (LiveKit).

Full-duplex: continuous mic, streaming STT (Groq Whisper), Rime TTS, Silero VAD + barge-in.

Turn path (fast, deterministic): every finished user turn goes straight into the engine
(`Brain.observe`, ~5 ms against SQLite) and its approved reply is spoken with Rime. No LLM
round-trip sits between the manager and the answer, so a rate-limited provider can no longer
leave the conversation silent. The LLM (Cerebras -> NVIDIA -> Groq fallback chain) is only
used when the engine cannot resolve a question from the record, and even then it may speak
only what its `recall` tool returns.

Run:  ./run.sh   (or: .venv/bin/python worker.py dev)
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(REPO_ROOT / ".env")
# Keep local provider credentials out of tracked files; same override the backend uses.
load_dotenv(REPO_ROOT / "backend" / ".env.local", override=True)

from livekit import rtc  # noqa: E402
from livekit.agents import (  # noqa: E402
    Agent, AgentSession, JobContext, RoomInputOptions, StopResponse, WorkerOptions, cli,
    function_tool,
)
from livekit.agents import RunContext, llm  # noqa: E402
from livekit.plugins import groq, openai, rime, silero  # noqa: E402

from engine_bridge import Brain  # noqa: E402
from engine.extract import extract  # noqa: E402
from engine.memory import greeting  # noqa: E402
from engine.speech import speakable  # noqa: E402
from voiceprofile import VoiceProfiler  # noqa: E402

logger = logging.getLogger("vesper.agent")
logging.basicConfig(level=logging.INFO)

INSTRUCTIONS = """
You are Vesper, the QA/QC colleague of this project's site manager. Plain spoken English,
at most two short sentences, numbers said so they are easy to hear over site noise.

You are only called when the project engine could not answer the manager's question itself.
- Call `recall` with the manager's question, then answer ONLY from what it returns.
- Never state a drawing, revision, date, RFI, clause or measurement that is not in SITE
  MEMORY or a tool result. If recall finds nothing, say so and ask for a grid line, drawing
  number or RFI.
- Never claim anything was logged; logging happens elsewhere.

SITE MEMORY:
{site_brief}
"""

DATA_TOPIC = "vesper"          # agent -> browser (engine results, brief, speaker state)
COMMAND_TOPIC = "vesper-cmd"   # browser -> agent (decision buttons, typed questions)


def _keyok(name: str) -> bool:
    v = os.getenv(name, "").strip()
    return bool(v) and not v.startswith("<")


def _llm() -> llm.LLM:
    """Cerebras first (fastest inference), NVIDIA NIM next, Groq last. FallbackAdapter moves
    to the next provider on error / timeout, so one exhausted quota never silences Vesper."""
    chain: list[llm.LLM] = []
    if _keyok("CEREBRAS_API_KEY"):
        chain.append(openai.LLM.with_cerebras(
            model=os.getenv("CEREBRAS_LLM_MODEL", "gpt-oss-120b"),
            api_key=os.getenv("CEREBRAS_API_KEY"), temperature=0.2, reasoning_effort="low"))
    if _keyok("NVIDIA_API_KEY"):
        chain.append(openai.LLM(
            model=os.getenv("NVIDIA_LLM_MODEL", "nvidia/llama-3.1-nemotron-70b-instruct"),
            base_url=os.getenv("NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1"),
            api_key=os.getenv("NVIDIA_API_KEY"), temperature=0.2))
    if _keyok("GROQ_API_KEY"):
        chain.append(openai.LLM(
            model=os.getenv("GROQ_LLM_MODEL", "openai/gpt-oss-20b"),
            base_url=os.getenv("GROQ_BASE_URL", "https://api.groq.com/openai/v1"),
            api_key=os.getenv("GROQ_API_KEY"), temperature=0.2, reasoning_effort="low"))
    if not chain:
        raise RuntimeError("no LLM key configured (CEREBRAS_API_KEY / NVIDIA_API_KEY / GROQ_API_KEY)")
    return chain[0] if len(chain) == 1 else llm.FallbackAdapter(chain, attempt_timeout=6.0)


# Whisper continues the STYLE of its prompt, so this is a sample site transcript rather than
# a word list — it biases decoding toward grid refs, drawing numbers, revisions and QA terms.
STT_PROMPT = (
    "Column line C-5, rebar spacing 180 millimetres, drawing A-102 revision R4. "
    "Cover at E-1 column is 40 millimetres per IS 456. Stirrup spacing at C-6 measured 220. "
    "RW-1 retaining wall on C-401 revision R2, excavation permit EXC-0041. "
    "L4 slab thickness 150 millimetres on S-301 revision R2, RFI-050 still open. "
    "What is the cover at E-2? Raise an NCR. Log the observation. Pre-pour hold point."
)


def _stt():
    # large-v3, not turbo: turbo was ~150 ms faster but hallucinated the prompt under 5 dB drill
    # noise in scripts/voice_acceptance.py (T2). Accuracy in noise is the product.
    return groq.STT(model=os.getenv("GROQ_STT_MODEL", "whisper-large-v3"), language="en",
                    prompt=STT_PROMPT)


def _tts():
    # English, low latency: mistv3 over websocket cuts first-audio delay.
    return rime.TTS(model="mistv3", speaker=os.getenv("RIME_SPEAKER_EN", "cove"), lang="eng",
                    api_key=os.getenv("RIME_API_KEY"), use_websocket=True)


def _may_write(text: str) -> bool:
    ex = extract(text)
    return bool(ex.decision in ("log_observation", "raise_rfi", "raise_ncr", "stop_work") or ex.affirm)


class VesperAgent(Agent):
    def __init__(self, brain: Brain, room: rtc.Room) -> None:
        self.brain = brain
        self.room = room
        self.profiler: VoiceProfiler | None = None
        try:
            brief = brain.brief_text()
        except Exception as e:  # never let memory failure kill the session
            logger.warning("site brief unavailable: %s", e)
            brief = "(site memory unavailable — use the recall tool for any history)"
        super().__init__(instructions=INSTRUCTIONS.replace("{site_brief}", brief))

    async def publish(self, obj: dict) -> None:
        try:
            await self.room.local_participant.publish_data(
                json.dumps(obj, default=str).encode(), topic=DATA_TOPIC, reliable=True)
        except Exception:
            pass

    # ---- deterministic fast path ------------------------------------------------------
    async def on_user_turn_completed(self, turn_ctx: llm.ChatContext, new_message: llm.ChatMessage) -> None:
        text = (new_message.text_content or "").strip()
        if not text:
            raise StopResponse()
        await self.handle_text(text)
        result = self._last
        if result.get("kind") == "answer" and result.get("unresolved"):
            return  # let the LLM try, grounded by its recall tool
        raise StopResponse()

    async def handle_text(self, text: str, from_tap: bool = False) -> None:
        if from_tap:
            self._cut_speech()  # a tapped prompt supersedes whatever Vesper was still saying
        elif self.brain.speaker_required and self.profiler and _may_write(text):
            # a spoken command that could write is verified on its own audio, right now
            await self.profiler.verify_recent()
        result = self.brain.observe(text)
        self._last = result
        await self.publish({"type": "engine", "result": result, "user_text": text})
        logger.info("turn %r -> %s/%s", text[:60], result.get("kind"), result.get("state"))
        if not (result.get("kind") == "answer" and result.get("unresolved")):
            self._say(result)
        if (result.get("logged") or {}).get("observation_id"):
            await self.publish({"type": "brief", "brief": self.brain.site_brief()})  # memory refresh

    async def handle_decision(self, decision: str) -> None:
        self._cut_speech()
        result = self.brain.decide(decision)
        self._last = result
        await self.publish({"type": "engine", "result": result})
        self._say(result)
        if (result.get("logged") or {}).get("observation_id"):
            await self.publish({"type": "brief", "brief": self.brain.site_brief()})  # memory refresh

    def _cut_speech(self) -> None:
        try:
            self.session.interrupt()
        except Exception:
            pass

    def _say(self, result: dict) -> None:
        reply = result.get("spoken_reply") or ""
        if result.get("speaker_locked") and result.get("state") in ("challenging", "confirming", "blocked"):
            reply += " Logging is locked until your voice is verified."
        if reply:
            self.session.say(speakable(reply))  # full text is on screen; speech is shaped for the ear

    # ---- LLM tools (only reached for unresolved questions) ----------------------------
    @function_tool
    async def recall(self, ctx: RunContext, query: str) -> str:
        """Search project memory — drawing facts, past observations, RFIs, specs, DPRs.

        Args:
            query: what to look up, e.g. "C-5 rebar", "RFI 47", "L4 slab pour".
        """
        return json.dumps(self.brain.recall(query), ensure_ascii=False, default=str)


async def entrypoint(ctx: JobContext) -> None:
    await ctx.connect()
    participant = await ctx.wait_for_participant()
    try:
        meta = json.loads(participant.metadata or "{}")
    except ValueError:
        meta = {}
    user_id = meta.get("user_id") or participant.identity.split("#")[0] or "Site Manager (voice)"
    brain = Brain(user_id=user_id, language="en-IN")
    agent = VesperAgent(brain, ctx.room)
    agent._last = {}

    # live voice profiling (SpeechBrain via voiceid sidecar) -> gates the write decisions
    profiler = VoiceProfiler(brain, on_update=agent.publish)
    profiler.attach(ctx.room)
    agent.profiler = profiler

    session = AgentSession(
        stt=_stt(),
        llm=_llm(),
        tts=_tts(),
        vad=silero.VAD.load(min_silence_duration=0.35),
        user_away_timeout=1800.0,
        turn_handling={
            # Site commands are short and declarative: end the turn on voice activity rather than
            # the semantic end-of-turn model, which held uncertain turns ("Any open RFIs?") for
            # its full 3 s max delay.
            "turn_detection": "vad",
            "endpointing": {"min_delay": 0.3, "max_delay": 1.2},
            # Plain VAD interruption: LiveKit's cloud "adaptive" detector timed out mid barge-in
            # and only then fell back (2.3 s to stop Rime in T3). Groq Whisper has no streaming
            # interim words, so a word-count rule would wait for the whole correction. Interrupt on
            # >= 0.5 s of voice; if no words follow within 1 s it was noise and playback resumes.
            "interruption": {"mode": "vad", "min_duration": 0.5, "min_words": 0,
                             "resume_false_interruption": True, "false_interruption_timeout": 1.0},
            "preemptive_generation": {"enabled": False},  # replies come from the engine, not an LLM
        },
    )

    @ctx.room.on("data_received")
    def _on_cmd(packet: rtc.DataPacket) -> None:
        if packet.topic != COMMAND_TOPIC:
            return
        try:
            cmd = json.loads(packet.data.decode())
        except ValueError:
            return
        if cmd.get("type") == "decision" and cmd.get("decision"):
            asyncio.create_task(agent.handle_decision(str(cmd["decision"])))
        elif cmd.get("type") == "text" and str(cmd.get("text") or "").strip():
            asyncio.create_task(agent.handle_text(str(cmd["text"])[:400], from_tap=True))

    await session.start(agent=agent, room=ctx.room,
                        room_input_options=RoomInputOptions(close_on_disconnect=False))
    ctx.add_shutdown_callback(profiler.aclose)

    brief = brain.site_brief()
    await agent.publish({"type": "brief", "brief": brief})
    await agent.publish({"type": "session", "session_id": brain.session_id,
                         "speaker_required": brain.speaker_required,
                         "tts": {"provider": "rime", "model": "mistv3", "lang": "eng",
                                 "speaker": os.getenv("RIME_SPEAKER_EN", "cove"), "transport": "websocket"}})
    session.say(speakable(greeting(brief)))


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
