# vesper-ai — build plan

Voice-led operational memory for construction site managers. A spoken field observation is
cross-referenced against the drawing register, RFIs, permits and QA/QC hold points, then the
agent **challenges and confirms before anything is logged**. Contradiction detection is
deterministic (safety core). The spoken conversation around it is a real-time full-duplex
voice agent. Speaker ID ("persona") gates every logging action.

---

## ✅ DONE (v1 — text/REST build, keep as the logic + acceptance core)

- **Data layer** — `data/site.db` built, repeatable, verified. `data/DATA.md`. Templates
  100/300/150. All 10 scenarios have backing data.
- **Deterministic engine** (`backend/engine/`, `backend/db.py`) — **KEEP, this is the
  "logical layer":**
  - `extract.py` — Hinglish/English entity extraction with confidence
  - `contradictions.py` — 6 rules vs DB views (`revision_mismatch`, `dimension_mismatch`,
    `unknown_drawing`, `missing_critical_field`, `permit_blocker`, `hold_point_blocker`),
    each with evidence (issue date, RFI, code clause)
  - `db.py` — read layer (`repo.ts` port) + `persist.py` writes with the SAFETY GATE
    (re-verifies drawing = latest For-Construction, location exists, unit present,
    contradiction was spoken, before any write)
  - `llm.py` — NVIDIA NIM → Groq fallback slot-filler
- **Acceptance** — `backend/scenarios.py` → **10/10 scenarios pass, 0 wrong
  drawing/dimension/location logs**. Runs via CLI and `POST /api/scenarios/run`.
- **Backend** (`backend/main.py`, FastAPI/uvicorn :8000) — session/turn/decision,
  observations, scenarios, drawings/rfis/permits, **Rime TTS proxy** (`/api/tts`, model
  `coda`, speaker `nadi`, verified real MP3), **Groq Whisper STT** (`/api/stt`),
  speaker enroll/status proxy (`/api/voice/*`).
- **voiceid sidecar** (`voiceid/`, FastAPI :8788) — SpeechBrain ECAPA-TDNN, `/enroll`
  `/verify` `/health`, live in-browser enrollment flow. **KEEP.**
- **Frontend** (`app/`, Next :3000) — Observations / Scenarios / Enroll screens **KEEP**.
- Env, `run-all.sh`, `backend/run.sh`, `voiceid/run.sh`, READMEs, `DEMO.md`.

---

## ⚠️ WRONG in v1 — what this rebuild fixes

| Problem | Cause | Fix |
|---|---|---|
| **Can't talk to it — mic times out before mouse release** | hold-to-talk + `webkitSpeechRecognition` no-speech/`network` timeout on Linux Chromium; `onPointerLeave` ends the turn | Full-duplex voice agent (LiveKit). Click once → converse. VAD + turn detection, not press-and-hold. |
| **Not a conversation / not full duplex** | request/response `/api/turn` per utterance | LiveKit `AgentSession`: continuous mic, streaming STT, barge-in, agent speaks while listening |
| **Responses are hard-coded** | `backend/engine/replies.py` fixed Hinglish templates | LLM **response composer** grounded ONLY in the tool result (DB facts + contradiction output). Templates deleted; thin factual fallback kept for LLM-down. |
| **Not clearly "extract from DB then answer"** | logic is there but buried behind templates | Explicit agent tool `resolve_and_check(utterance)` → returns `{slots, facts, contradictions, blockers, allowed_decisions}` from the deterministic engine; LLM must speak only from that. |

`backend/engine/dialogue.py` (the FSM) and `replies.py` (templates) are **replaced**.
Everything else under `backend/engine/` + `db.py` + `voiceid/` + `data/` is **reused unchanged**.

---

## 🎯 Target architecture

```
┌─ browser (app/) ───────────────┐        ┌─ LiveKit server ─┐
│ @livekit/components-react      │  WebRTC │  room  (audio)   │
│  "Start conversation" button   │◄───────►│                  │
│  mic (continuous) + agent audio│        └─────────┬────────┘
│  live transcript, cards        │                  │ joins as agent
└────────────────────────────────┘                  ▼
                                   ┌─ agent worker (Python, livekit-agents) ─────────────┐
                                   │ AgentSession:                                        │
                                   │   VAD          silero  (speech start/end, barge-in)  │
                                   │   turn detect  livekit turn-detector (semantic EOT)  │
                                   │   STT          Groq Whisper (streaming)              │
                                   │   LLM          NVIDIA NIM / Groq  + TOOLS:           │
                                   │                  • resolve_and_check(utterance)      │──► backend/engine/  (extract + contradictions)
                                   │                  • log_observation / raise_rfi /     │──► backend/engine/persist.py  (SAFETY GATE)
                                   │                    raise_ncr / stop_work             │
                                   │                  system prompt: speak ONLY from tool │
                                   │                  results; Hinglish; name drawing/rev/│
                                   │                  date/RFI/numbers; end by asking      │
                                   │   TTS          Rime (coda/nadi)  via plugin or       │──► existing /api/tts logic
                                   │                custom adapter                        │
                                   │   PERSONA GATE buffer each user utterance's PCM →    │──► voiceid /verify
                                   │                if not enrolled manager, decision      │
                                   │                tools refuse + LLM says "locked"       │
                                   └─────────────────────────────────────────────────────┘
```

- **Deterministic engine stays the source of truth.** The LLM never invents a fact, a
  revision, an allowed decision, or a log — it calls tools and phrases their output.
- **Persona voice-ID** runs async per utterance so it never blocks the conversation; the
  gate is enforced only when a decision tool is called.
- Text path (`/api/turn`, `/api/decision`, scenario runner) **stays** — it's the
  acceptance harness and the noisy-room fallback.

---

## Prerequisites

**LiveKit server** — pick one:
- **Self-host (recommended for the demo, no signup):**
  `docker run --rm -p 7880:7880 -p 7881:7881 -p 7882:7882/udp livekit/livekit-server --dev`
  → `LIVEKIT_URL=ws://localhost:7880`, `LIVEKIT_API_KEY=devkey`, `LIVEKIT_API_SECRET=secret`
- **LiveKit Cloud (free tier):** create a project → `LIVEKIT_URL=wss://<proj>.livekit.cloud`,
  `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`

**New deps**
- Python (new `agent/` venv): `livekit-agents`, `livekit-plugins-silero`,
  `livekit-plugins-groq` (STT+LLM) or `livekit-plugins-openai` (point at NVIDIA/Groq base
  URLs), `livekit-plugins-turn-detector`, `livekit-plugins-rime` (if present; else custom TTS)
- Frontend: `@livekit/components-react`, `livekit-client`

**Env additions**
```
LIVEKIT_URL=ws://localhost:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
AGENT_STT=groq            # groq | deepgram
AGENT_LLM=nvidia          # nvidia | groq
AGENT_TTS=rime
```

---

## Phases

### Phase 0 — stopgap so the current build is usable (~15 min, independent of LiveKit)
- `app/components/TalkScreen.tsx`: hold-to-talk → **click-to-toggle** (click start, click
  stop), drop `onPointerLeave` stop, no implicit timeout. Server STT (`/api/stt`) already
  wired. This makes v1 demoable while the voice agent is built.

### Phase A — LiveKit transport up (~45 min)
- `agent/` dir: new `python3.12` venv, `livekit-agents` deps.
- `agent/worker.py` — minimal `AgentSession` that joins a room and echoes/repeats. Prove
  audio in+out.
- `backend/main.py`: `POST /api/rtc/token` → LiveKit JWT for a room (uses `LIVEKIT_*`).
- `app/components/ConversationScreen.tsx` — `LiveKitRoom` + `RoomAudioRenderer` +
  `<BarVisualizer>`; one "Start conversation" button → fetch token → connect. Replaces the
  Talk tab.
- **Gate:** you click Start, speak, hear the echo. Full-duplex path proven.

### Phase B — conversational pipeline (~40 min)
- Add to `AgentSession`: `silero` VAD, turn detector, Groq Whisper STT, Rime TTS (plugin or
  a ~40-line custom `TTS` wrapping the existing Rime call), a plain LLM.
- Live partial transcription surfaced to the frontend via LiveKit transcription events.
- **Gate:** natural back-and-forth; interrupting the agent stops its speech within ~300 ms.

### Phase C — logical layer, no hard-coded responses (~50 min)
- `agent/tools.py`:
  - `resolve_and_check(utterance, session_state)` → calls `engine.extract` +
    `engine.contradictions.check` against `db.Repo`; returns a compact JSON of
    `{slots, resolved_facts, contradictions[], blockers[], missing[], allowed_decisions[]}`.
  - `log_observation / raise_rfi / raise_ncr / stop_work` → `engine.persist.*` (unchanged
    SAFETY GATE; raises → tool returns the refusal reason for the LLM to speak).
- `agent/prompt.py` — system prompt: *"You are Vesper, a QC assistant on an Indian
  construction site. You may ONLY state drawing numbers, revisions, dates, RFI numbers and
  measurements that appear in a tool result. Never guess. Speak Hinglish in Roman script.
  When there is a contradiction, name the latest drawing + revision + issue date + the RFI
  + the numbers, then ask the manager to choose (log / RFI / NCR). Before any log, you must
  have spoken the contradiction. If a decision tool returns a refusal, read it out."*
- **Delete `backend/engine/replies.py` templates**; `backend/main.py` `/api/turn` uses the
  same composer (LLM) with a **thin factual fallback** (one sentence from the tool result,
  no template prose) when the LLM errors/times out.
- Update `backend/scenarios.py`: assert each scenario's `challenge_mentions`
  (e.g. `R4`, `RFI-047`, `180`) appear in the composed reply; keep the hard invariants
  (0 wrong logs, contradiction spoken before log). Target: **still 10/10.**

### Phase D — persona voice-ID in the pipeline (~35 min)
- In the agent, capture each finished user utterance's audio (LiveKit gives the user track;
  buffer PCM between VAD start/end) → encode → `POST voiceid /verify`.
- Keep `session.speaker_ok` (bool + score), refreshed per utterance, non-blocking.
- The `log_observation / raise_rfi / raise_ncr / stop_work` tools check `session.speaker_ok`
  first; if false → return `"speaker not verified as <enrolled manager>; logging locked"` →
  LLM speaks it. Conversation continues; only writes are gated.
- Enrollment: the existing **Enroll** tab (records 3 clips → `/api/voice/enroll`) is reused.
  Add a one-line "who am I hearing?" indicator in the Conversation screen from the latest
  `verify` score.
- Tune `SPEAKER_ID_THRESHOLD` with the real enrolled voice vs a second person.

### Phase E — polish + demo (~30 min)
- Observation / contradiction cards in the Conversation screen: agent publishes a data
  message (`{type:"state", contradictions, resolved, allowed}`) after each
  `resolve_and_check`; frontend renders the red/amber cards + decision chips (chips also
  trigger the same tools by sending a data message back).
- Observations / Scenarios / Enroll tabs unchanged (REST).
- `run-all.sh` gains the LiveKit server + `agent/worker.py`.
- Rehearse: S01 revision mismatch → interrupt mid-reply (S03) → S05 hot-work blocked →
  Observations + `POST /api/scenarios/run` table.

---

## What stays / what changes

| Reused unchanged | Replaced | New |
|---|---|---|
| `data/` (schema, build_db, site.db, scenarios) | `backend/engine/dialogue.py` (FSM) | `agent/` — LiveKit worker, tools, prompt |
| `backend/engine/extract.py`, `contradictions.py` | `backend/engine/replies.py` (templates) | `POST /api/rtc/token` |
| `backend/engine/persist.py` + safety gate, `db.py` | `app/components/TalkScreen.tsx` (push-to-talk) | `app/components/ConversationScreen.tsx` (LiveKit) |
| `voiceid/` sidecar + Enroll tab | live path's browser `webkitSpeechRecognition` | LiveKit server (self-host or Cloud) |
| `backend/scenarios.py` (assertions extended) | | |
| `backend/main.py` `/api/turn` `/api/decision` (text/fallback + acceptance) | | |
| Rime `/api/tts`, Groq `/api/stt` (reused by the agent TTS/STT) | | |

---

## Hard rules (unchanged — enforced in `persist.py` gate AND the agent tools)

1. Never log without having SPOKEN the challenge for every contradiction.
2. Never log an unconfirmed / low-confidence slot (incl. LLM-only suggestions).
3. Logged `drawing_id` MUST be the verified latest For-Construction revision.
4. While a permit / hold-point blocker is open: only `stop_work`, `raise_ncr`, `cancel`.
5. **New:** a logging tool runs only if the current speaker is the enrolled manager.

---

## Acceptance (updated)

- `backend/scenarios.py` — S01–S10 through the **new composer** (text mode): all 10 behave,
  0 wrong drawing/dimension/location logs, every `challenge_mentions` token present, every
  contradiction spoken before its log.
- Live: click Start → speak S01 → agent challenges from DB facts (not a template) → say
  "log kar do" → `field_observations` row linked to `A-102@R4` → interrupt the agent
  mid-sentence and it stops → a second person's voice cannot log.

---

## Open items

1. **LiveKit:** self-host (`--dev`, no keys) or Cloud (keys)? Default: self-host.
2. **STT:** Groq Whisper (have key, ~300–600 ms) or Deepgram (free tier, true streaming)?
   Default: Groq.
3. **Turn-taking feel:** semantic turn-detector (best) needs a model download (~messages);
   fallback is VAD silence timeout. Default: try turn-detector, fall back to VAD.
4. Keep `/api/turn` text path for the noisy-room fallback? Default: yes.
