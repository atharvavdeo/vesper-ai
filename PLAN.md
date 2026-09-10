# Parallel build plan — vesper-ai MVP (~1.5 h)

Voice-led operational memory for construction site managers. Speech cross-references a
spoken field observation against tender/BOQ, drawing revisions, RFIs, submittals and DPRs,
then **challenges and confirms before logging**. Contradiction detection is the core
feature; voice is the safety gate; **speaker ID gates logging** (non-negotiable).

## Decisions (locked)

| Question | Decision |
|---|---|
| Backend engine | **Fresh minimal Python engine** in `backend/`, using `../DataForge-Rime/agent/` (working 1316-line reasoning loop, reads `site.db`) and `app/lib/*.ts` as reference only |
| Frontend | **Keep the Next.js `app/`**, talking to the Python API |
| Parallelism | **Dir-partitioned parallel subagents** on one working tree, frozen interface contract between them |
| LLM | **NVIDIA NIM on** for entity 2nd-opinion + Hinglish challenge phrasing, **deterministic parser fallback** on any error/timeout |
| Speaker ID | Gate logging. Reference: github.com/Inference-LAB/VocalID — MVP uses its core model (SpeechBrain ECAPA-TDNN) directly with cosine similarity vs one enrolled speaker |

## Data status — DONE

`data/site.db` built, verified, repeatable (`python3 data/build_db.py` twice = identical).
All 10 scenarios (S01–S10) have backing data — see `data/DATA.md`. Templates 100/300/150.
S01 fact path: `P1:C-5:L3 / rebar_spacing → A-102@R4 | 180 mm | ±10 | RFI-047 | IS 456 Cl. 26.5.3.2(c)`.
Known gap (acceptable): ~311 of 550 templates are header-only (scrape stopped at ~200/523);
no scenario touches them.

## Directory partition (no two workstreams touch the same files)

| Dir | WS | Contents |
|---|---|---|
| `backend/` | A | FastAPI: fresh engine (extract, contradictions, dialogue, replies, persist), NIM LLM, all `/api/*` routes, Rime TTS proxy, reads `data/site.db` |
| `voiceid/` | B | Speaker-ID sidecar (already scaffolded: `app.py`, `requirements.txt`) — venv, model, service, enroll script |
| `app/` | C | Next.js frontend: Talk / Observations / Scenarios screens, mic + barge-in, TTS playback |
| `backend/tests/` | D | Python scenario runner (S01–S10) + parser unit tests |
| `.env`, `data/` | me | done; frozen |

## Frozen interface contract

To be written verbatim to `backend/CONTRACT.md` in Phase 0. Nobody deviates.

### Backend API — `http://localhost:8000`

```
GET  /api/health              -> {db, llm, rime, voiceid}
POST /api/session             -> {sessionId}
POST /api/turn   multipart {sessionId, text, bargeIn?, audio?}
     -> {state, entities[], contradictions[], blockers[], missing[],
         reply:{text,speech}, allowedDecisions[], slots{},
         resolved:{drawing_id, location_id, fact}, speaker:{match,score}|null}
POST /api/decision  {sessionId, decision}
     -> {state, logged:{observation_id?, rfi_id?, decision}|null, reply:{text,speech}}
GET  /api/observations        -> [{observation_id, location_id, drawing_id, attribute,
                                   value_claimed, unit, final_decision, contradiction_kinds, created_at}]
GET  /api/observations/{id}   -> full row + evidence
GET  /api/scenarios           -> [{id, title}]
POST /api/scenarios/run       -> {results:[{id, title, pass, failures[], kindsSeen[],
                                   clarified, finalDecision, logged[], transcript[]}]}
POST /api/tts    {text}       -> audio/mpeg  (503 if RIME_API_KEY missing -> frontend uses SpeechSynthesis)
```

### Speaker-ID sidecar — `http://localhost:8788` (backend proxies)

```
GET  /health              -> {status, enrolled, threshold}
POST /enroll  files=[wav] -> {enrolled, samples, cohesion}
POST /verify  file=wav    -> {match, score, threshold}
```

### Gate rule

On `/api/turn` with `audio`, backend calls `/verify`. If `SPEAKER_ID_ENABLED=true` and
`match=false` -> `allowedDecisions` returned as `[]` plus a `speaker_gate` entry in
`blockers`; `/api/decision` returns 403 for any logging decision. Typed-only turns
(no audio) skip the gate — the typed box is the trusted operator console / noisy-room
fallback. **(Open item 1 — confirm.)**

## Hard rules (enforced in dialogue.py AND re-checked in persist.py)

1. Never log without first SPEAKING the challenge for every contradiction.
2. Never log an unconfirmed or low-confidence slot (incl. anything only the LLM suggested).
3. The logged `drawing_id` MUST be the verified latest For-Construction revision.
4. While a permit or hold-point blocker is open, only `stop_work`, `raise_ncr`, `cancel`
   are allowed.

Critical fields (certain before logging): location, drawing_number, dimension_claimed
(plus element / attribute / value / drawing clarity).

## Contradiction rules (`backend/engine/contradictions.py`, vs DB views)

| kind | triggers when |
|---|---|
| `revision_mismatch` | spoken revision != latest |
| `dimension_mismatch` | spoken value outside drawing tolerance |
| `unknown_drawing` | drawing number not in register |
| `missing_critical_field` | location/element/attribute/value/drawing unclear |
| `permit_blocker` | active permit has an unsatisfied mandatory check (`v_permit_blockers`) |
| `hold_point_blocker` | pre-pour hold point not released (`v_open_hold_points`) |

Each result carries evidence: date issued, the RFI behind the revision, the code clause.

## Phases

### Phase 0 — me, ~10 min (blocking, serial)
- Write `backend/CONTRACT.md`.
- Scaffold `backend/`: `main.py` (FastAPI + all routes, typed stubs), `db.py` (site.db
  read helpers + views), `config.py` (loads root `.env`), `requirements.txt`.
- Leave everything uncommitted.

### Phase 1 — 3 subagents in parallel + me, ~50 min
- **WS-B (haiku subagent)** — `voiceid/`: create `python3.12` venv, `pip install -r
  requirements.txt`, pre-download ECAPA model, start service, smoke-test `/health`
  `/enroll` `/verify` with generated WAVs. Fully independent — starts immediately.
- **WS-A (sonnet subagent)** — `backend/engine/`: `extract.py` (Hinglish slots +
  confidence), `contradictions.py` (6 rules vs views), `dialogue.py` (state machine +
  4 hard rules), `replies.py` (fixed Hinglish templates, Roman script, name drawing /
  revision / issue date / RFI / numbers, end by asking manager to choose),
  `persist.py` (voice_sessions/turns incl. was_barge_in; field_observations linked to
  QC-SPW-REG-004; RFI row status Open on raise_rfi). `llm.py` = NVIDIA NIM
  (OpenAI-compatible, `NVIDIA_BASE_URL`), deterministic fallback on error/timeout.
  Wire into the Phase-0 routes.
- **WS-C (sonnet subagent)** — `app/`: strip default scaffold; build against
  `CONTRACT.md` with a local mock. **Talk** screen (push-to-talk mic,
  `webkitSpeechRecognition` continuous + partials + en-IN/hi-IN toggle, typed fallback,
  live transcript + chips `C-5 · column · 180 mm · A-102 · R3`, red contradiction card /
  amber blocker card, reply bubble with waveform, decision buttons, barge-in = stop
  `<audio>` on `onspeechstart`/first partial and mark `bargeIn:true`, `MediaRecorder`
  blob -> `/api/turn`). **Observations** (list + detail: drawing rev, RFI, contradiction
  kinds). **Scenarios** (calls `/api/scenarios/run`, pass/fail table + transcript). TTS
  via `/api/tts` through one `<audio>` element; SpeechSynthesis hi-IN fallback + "Rime
  key missing" badge. API base from `NEXT_PUBLIC_API_BASE`.
- **Me** — Rime `/api/tts` proxy (verify endpoint at docs.rime.ai; historically
  `POST https://users.rime.ai/v1/rime-tts`, `Authorization: Bearer`, `Accept: audio/mp3`,
  body `{text, speaker, modelId: arcana, lang: hi}`; stream through; small LRU;
  clear error when key missing) + `/api/scenarios/run` runner glue + integrate WS-A on
  landing + review subagent output.

### Phase 2 — me + 1 subagent, ~20 min
- **WS-D (sonnet subagent)** — `backend/tests/`: `run_scenarios.py` (copy `site.db` ->
  temp, play S01–S10 turn-by-turn through the engine, print pass/fail table; PASS = all
  10 behave AND no observation ever logged with the wrong drawing / dimension /
  location) + `test_extract.py` unit tests.
- **Me** — run it, fix engine bugs until 10/10 green. Then live end-to-end through the
  real frontend: S01 (revision mismatch -> log R4), S03 (barge-in C-5 -> C-6), S05
  (hot-work blocked -> stop work); confirm Observations shows `A-102@R4`.

### Phase 3 — ~10 min
- Enroll the manager voice (`voiceid/enroll.py voiceid/samples/*.wav`), set
  `SPEAKER_ID_ENABLED=true`, verify a wrong-speaker voice turn gets gated.
- `app/README.md` + root run instructions (3 processes: `voiceid` :8788, `backend`
  :8000, `app` :3000).
- Rehearse the 3-min demo: S01 revision mismatch -> S03 barge-in -> S05 hot-work blocked
  -> show Observations log + scenario pass table.

## Env (root `.env`, gitignored)

```
SITE_DB_PATH=../data/site.db
RIME_API_KEY=...            # NEEDED by Phase 3 (frontend has SpeechSynthesis fallback)
RIME_MODEL=arcana
RIME_SPEAKER=...            # Hindi / Indian-English speaker, pick from docs.rime.ai
RIME_LANG=hi
NVIDIA_API_KEY=...          # PRESENT
NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1
NVIDIA_LLM_MODEL=meta/llama-3.3-70b-instruct
GROQ_API_KEY=...            # optional fallback LLM
GROQ_BASE_URL=https://api.groq.com/openai/v1
GROQ_LLM_MODEL=llama-3.3-70b-versatile
CRITICAL_FIELDS=location,drawing_number,dimension_claimed
SPEAKER_ID_ENABLED=true
SPEAKER_ID_URL=http://localhost:8788
SPEAKER_ID_THRESHOLD=0.70
SPEAKER_ID_MODEL_DIR=./voiceid/models
```

## Open items — need decision (not blocking Phase 0 / Phase 1 start)

1. **Typed input bypasses the speaker gate** (voice turns gated, typed console trusted) —
   confirm, or gate typed input too.
2. **Backend Python = `python3.12`** (`~/.local/bin/python3.12`; system `python3` is 3.14
   with no torch/speechbrain wheels) — confirm.
3. **Keys:** `NVIDIA_API_KEY` present. Need `RIME_API_KEY` + a Hindi-capable
   `RIME_SPEAKER` by Phase 3. `GROQ_API_KEY` optional.
4. **Voice enrollment:** 3× ~6-second WAV clips of the manager speaking (quiet room),
   dropped in `voiceid/samples/`. Needed Phase 3.
5. **`app/lib/` TS engine** — leave in place as dead reference, or delete so the repo has
   one engine.

## Demo (3 min, live mic)

S01 revision mismatch -> S03 barge-in -> S05 hot-work blocked -> show Observations log +
scenario pass table.

## Acceptance

`python backend/tests/run_scenarios.py` — plays S01–S10 against a temp copy of `site.db`,
prints a pass/fail table. PASS = all 10 behave as expected AND no observation is ever
logged with the wrong drawing, dimension or location.
