# Rime evidence

## Hard voice claim

**A site manager can talk to Vesper hands-free on a noisy site, cut it off mid-sentence to correct
themselves, and the product stays consistent with what they actually heard and said.** When the
manager interrupts a spoken challenge, Rime playback stops, the stale challenge is never resumed
or repeated, and the correction is what the engine holds, speaks back and logs. A different voice
saying the same command cannot write anything.

This combines three of the brief's directions that matter on a construction site: **interruption
and recovery**, **adverse audio** (drill noise), and **perceived response time**. It is measured
on the shipped path, from audio in to audio out, not from logs.

## Rime configuration (exact)

| Path | Model | Speaker | Language | Endpoint / transport | Audio |
| --- | --- | --- | --- | --- | --- |
| **Live voice (judged flow)** | `mistv3` | `cove` | `eng` | LiveKit Agents `livekit-plugins-rime` 1.8.0, `use_websocket=True` (Rime streaming websocket) → LiveKit WebRTC to the browser | PCM from Rime → Opus over WebRTC |
| Talk, English | `mistv3` | `cove` | `eng` | `POST https://users.rime.ai/v1/rime-tts` via the backend's `/api/tts` proxy | `Accept: audio/mp3` → `audio/mpeg`, one `<audio>` element |
| Talk, Hinglish (organizer config) | `arcana` | `astra` | `hin` | same HTTPS endpoint and proxy | same |

- The Rime key lives only in server-side env (`backend/.env.local`, Render secrets). The browser
  never sees it; `/api/tts` requires a signed-in user.
- **The active provider is visible.** The Live screen prints `voice out: rime mistv3 · cove ·
  websocket`, published by the agent when the room starts. Talk shows `RIME` in the status line and
  a **No Rime key** badge if it ever falls back to browser speech synthesis.
- **Organizer preflight passes:**
  - `python3 scripts/rime_preflight.py --env-file backend/.env.local` → `Rime configuration: OK (arcana / astra / hin; secret present)`
  - adding `--request` → `Rime request: OK (audio/mp3, 33600 bytes)`
- The LiveKit Rime plugin logs "Rime Arcana is no longer supported. Use model="coda"" when asked
  for `arcana`. The REST endpoint still serves `arcana/astra/hin` (the preflight passes), so the
  Hinglish Talk path keeps the organizer configuration. The live path uses `mistv3`, not `arcana`.

## Acceptance test (defined before the final run)

`scripts/voice_acceptance.py` joins a real LiveKit room as the manager. It **speaks** committed
WAV fixtures into the microphone track in real time and records the agent's Rime audio track frame
by frame. All timings are measured on audio: "first audio" means the agent track's RMS crosses the
speech threshold.

| Test | Pass criterion |
| --- | --- |
| **T1** end-of-turn → first audible Rime audio, 3 questions × 2 rounds | median ≤ 1500 ms, max ≤ 2500 ms, every answer correct |
| **T2** the same question mixed with synthetic drill noise at 5 dB SNR | correct answer (E-1, 40 mm) |
| **T3** interrupt the spoken challenge with *"Wait, not E one. E two. Cover is thirty eight millimetres."* | Rime audio stops ≤ 1500 ms after the manager starts talking; engine now holds E-2 / 38 mm; the stale E-1 challenge is never re-spoken |
| **T4** a *different* voice says "Okay, log that observation." | nothing is written |
| **T5** the enrolled manager says it | the observation is written, linked to the verified drawing revision |

Fixtures (`evidence/fixtures/`, regenerate with `scripts/make_voice_fixtures.py`) are synthetic
macOS voices: "Samantha" is enrolled as the manager, "Daniel" plays the intruder. The drill noise is
band-limited noise with 18 Hz hammer impulses. No real person's voice is used.

## Procedure

```bash
python3 scripts/rime_preflight.py --env-file backend/.env.local --request
./run-all.sh                                   # voiceid :8788 · backend :8000 · frontend :3000
cp data/site.db /tmp/vesper-acceptance.db      # the test writes; keep data/site.db clean
(cd agent && SITE_DB_PATH=/tmp/vesper-acceptance.db SPEAKER_ID_ENABLED=true .venv/bin/python worker.py dev)
agent/.venv/bin/python scripts/voice_acceptance.py          # → evidence/runs/<stamp>/
agent/.venv/bin/python scripts/rime_delivery_check.py       # → evidence/delivery/
```

The test enrols its own voiceprint under a separate user id (`acceptance-test`), so it never
overwrites a real manager's enrolment.

## Result — run `20260911-003352` (MacBook, home broadband → LiveKit Cloud India South, warm connections)

Full report: [`evidence/runs/20260911-003352/report.md`](evidence/runs/20260911-003352/report.md).
Everything Vesper said is in [`heard.mp3`](evidence/runs/20260911-003352/heard.mp3), and everything the manager said is in
[`mic.mp3`](evidence/runs/20260911-003352/mic.mp3).

| Test | Result | Measured |
| --- | --- | --- |
| T1 first audible audio | **MISS** (target p50 ≤ 1500 ms) | median **1988 ms**, max 2591 ms, n = 6; 6/6 answers correct |
| T2 drill noise, 5 dB SNR | **PASS** | answered E-1 = 40 mm ± 5; first audio 1949 ms |
| T3 barge-in with correction | **PASS** | Rime stopped **1065 ms** after the manager started talking. The engine then held `E-2 / cover / 38 mm`, and Vesper said *"At E-2, Level 1, column cover is 38 mm, which matches A-201 R1. Log it?"*; the E-1 challenge was never resumed |
| T4 intruder "log that observation" | **PASS** | voiceprint score **0.03** (threshold 0.70) → refused, nothing written |
| T5 manager "log that observation" | **PASS** | written as `OBS-000110`, linked to **A-201@R1** |

**Where T1's ~2 s goes:**
- Groq Whisper `whisper-large-v3` returns the final transcript a median **654 ms** after the
  manager stops speaking (range 616–765 ms, n = 11; `stt_breakdown.txt`).
- The engine answers in about **5–10 ms**.
- Rime `mistv3` over websocket returns first audio in about **320–390 ms** warm, and **~1.1 s on the first
  call of a connection** (`evidence/delivery/results.json`).
- The rest is VAD silence detection (0.35 s), endpointing (0.3 s) and WebRTC playout.
- The dominant cost is batch STT. Groq Whisper has no streaming interim results.

## What the test found, and what changed because of it

Each fix below was driven by a failing run of the acceptance test. The earlier runs were
overwritten; the final run above is the one that counts.

1. **Speaker gate bypass (security).** A different voice saying "OK, log that" was written in an
   early run. The gate ran before the "okay → accept the offered log" path.
   - Fix: the gate now runs after every way a decision can arise (`backend/engine/dialogue.py`).
   - Fix: the command's own utterance is re-verified at write time (`agent/voiceprofile.py`, `verify_recent`), so it no longer rides on the rolling 4 s check.
2. **Slow barge-in (5.3 s, then 2.3 s).**
   - A word-count interruption rule waited for Whisper's whole transcript.
   - LiveKit's cloud "adaptive" interruption detector then timed out mid-barge before falling back.
   - Fix: plain VAD interruption (≥ 0.5 s of voice), with false-interruption resume for noise → **1.07 s**.
3. **3–4 s waits on uncertain turns.** The semantic end-of-turn model held "Any open RFIs?" (end-of-turn probability 0.39) for its full 3 s maximum delay. Fix: VAD endpointing, 0.3 s min, 1.2 s max.
4. **Whisper turbo hallucinated under noise.** `whisper-large-v3-turbo` was about 150 ms faster, but
   under 5 dB drill noise it transcribed the question as its own prompt ("Pre-pour hold point").
   Reverted to `whisper-large-v3`, because accuracy in noise is the product.
5. **Rime delivery: long lists never played.** The open-RFI answer is one 230-character sentence
   joined by semicolons, with an en dash ("L3–L4"). On the Rime websocket it produced **no audio
   within 25 s** (timeout, then retry). `engine/speech.py → speakable()` now shapes every reply for the ear before
   Rime: ranges become "to", semicolons become sentences, parentheses become asides, and spoken length is capped with "the rest is on your screen".
   Same model, voice and transport (`scripts/rime_delivery_check.py`, clips in `evidence/delivery/`):

   | Item | Raw text | Shaped by `speakable()` |
   | --- | --- | --- |
   | open RFIs list | no audio in 25 s (timeout) | first audio **1165 ms** (first call on the connection) |
   | cover answer with a clause in parentheses | 852 ms | **389 ms** |
   | contradiction challenge (already short) | 332 ms | 330 ms |
6. **A topic question lost to follow-up context.** "Any open RFIs?" asked right after an E-1 question
   was answered about E-1. The early harness scored this as a pass because it only looked for the text "RFI-0".
   - Fix: a question that names no location of its own no longer inherits one (`engine/answer.py`).
   - Fix: the harness now matches each answer's exact text.

## Limitations

- **T1 misses its target.** First audible audio is about 2 s after the manager stops talking, not ≤ 1.5 s.
  - Most of it is batch Whisper STT (~650 ms) plus VAD and endpointing windows.
  - A streaming STT provider (none is configured with our current keys) is the next step.
- **Synthetic voices and synthetic noise.** This is a repeatable proxy for a site, not a physical phone on a real
  slab. The browser path adds echo cancellation and noise suppression, which the test's direct track does not use.
- **Barge-in stop is measured with a 600 ms-quiet detector,** so reported stop times include up to
  that detection granularity at the start of silence. Agent audio is measured at the room, not at a
  phone speaker.
- **Rime cold start.** The first synthesis on a new websocket takes ~1.1 s. The spoken greeting warms the
  connection before the first question.
- **Occasional websocket retries.** The LiveKit Rime plugin retried a few syntheses during runs; the replies were still
  delivered.
- **Buffered Talk proxy.** The Talk `/api/tts` proxy buffers the full MP3 before playback. The live path is the streaming one.
- **Single run.** The numbers come from one run on one network (n = 6 for T1). Treat them as indicative, not as a distribution.
