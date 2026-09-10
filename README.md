# Vesper.ai — Voice-led operational memory for construction sites

## Problem
Site managers live in a fragmented info environment: tender/BOQ, drawing register, RFIs, submittals,
DPRs, permits, WhatsApp voice notes. The failure mode is not missing data — it is **contradictions between
what was tendered, what is being built, and what is reported today**, noticed only at rework / payment dispute / incident.
Procore, Aconex, RIB, SiteSetu unify documents into dashboards, but the manager still correlates a spoken
observation with the right drawing revision / BOQ item / RFI by hand. Voice today = dictation or Q&A.

**Vesper reframes it as voice-led operational memory:** ingest tender, drawings, RFIs, submittals, DPRs,
permits, QA/QC checklists; then use real-time speech to **query, challenge and confirm** field observations
*before* they are logged. Voice is the safety gate, not a transcription box.

## Runtime loop
1. Manager speaks (Hinglish, noisy, interrupted):
   "Column line C-5 pe rebar spacing 180 mm hai, drawing A-102 Rev 3 mein 200 mm dikh raha hai."
2. Entity extraction → `{location: C-5, element: column, attribute: rebar_spacing, value: 180 mm, drawing: A-102, revision_claimed: R3}`
3. Retrieval + deterministic contradiction rules against latest `For Construction` revision (`v_current_facts`):
   - value ≠ latest fact (beyond tolerance) → `dimension_mismatch`
   - revision_claimed ≠ latest → `revision_mismatch`
   - permit mandatory check unsatisfied → `permit_blocker`; QA hold point not released → `hold_point_blocker`
4. Spoken challenge via **Rime TTS** (Hinglish):
   "Drawing A-102 ki latest revision R4 hai, jo 12 August ko issue hui thi. Usme spacing 180 mm hai.
   RFI-047 ne yeh confirm kiya tha. Kya aap observation log karna chahte hain, ya RFI raise karna chahte hain?"
5. User decides → `field_observations` row linked to verified `drawing_id`, `location_id`, decision.
   Critical field uncertain → agent refuses to log and asks.

## Architecture (3 processes, no LiveKit / no WebRTC transport)
```
app/       Next.js frontend (:3000)  — Talk / Observations / Scenarios / Enroll screens
                                        STT = browser webkitSpeechRecognition
                                        mic capture / speaker-ID audio = getUserMedia + MediaRecorder
                                        TTS playback = <audio> from /api/tts, speechSynthesis fallback
backend/   FastAPI on uvicorn (:8000) — deterministic Hinglish engine (extract → contradictions →
                                        dialogue state machine → replies → persist), reads data/site.db,
                                        NVIDIA NIM (Groq fallback) for entity 2nd-opinion + phrasing,
                                        Rime TTS proxy, speaker-gate, scenario runner
voiceid/   FastAPI on uvicorn (:8788) — SpeechBrain ECAPA-TDNN speaker verification vs one enrolled
                                        manager (cosine similarity). Gates all logging.
```

## Run
```bash
python3 data/build_db.py          # build data/site.db (idempotent; run twice = identical)
./run-all.sh                      # starts voiceid :8788, backend :8000, frontend :3000
#   or individually:  ./voiceid/run.sh   ./backend/run.sh   (cd app && npm run dev)
```
First `voiceid` boot downloads the ECAPA model (~80 MB) once. Then open http://localhost:3000,
go to **Enroll**, record 3 live voice samples, then use **Talk**.

## Acceptance test
10 scripted scenarios (S01–S10) with deliberate errors + barge-in. Pass = all 10 behave as
expected AND zero observations logged with the wrong drawing / dimension / location; every
contradiction produced a spoken clarification first.
```bash
cd backend && PYTHONPATH=. .venv/bin/python scenarios.py     # CLI pass/fail table
#  or:  POST http://localhost:8000/api/scenarios/run
```

## Layout
```
data/schema.sql          SQLite schema (shared contract)
data/build_db.py         Builds site.db from raw/ + seed/
data/seed/               Demo project P1 + scenarios.json (S01–S10)
data/site.db             Built database
data/DATA.md             Build steps, row counts, sanity checks, known gaps
backend/CONTRACT.md      Frozen HTTP + engine interface (all workstreams build to this)
backend/engine/          extract · contradictions · dialogue · replies · llm (ported from the TS reference)
voiceid/                 Speaker-ID sidecar + enroll.py
landing/index.html       Marketing landing page
.env                     SITE_DB_PATH, RIME_*, NVIDIA_*, GROQ_*, SPEAKER_ID_*  (gitignored, never commit)
```

## Demo project contract (seed data — app + scenarios depend on these exact IDs)
- Project `P1` — "Tower B, Residential G+12, Hinjewadi, Pune", CPWD item-rate contract.
- Locations `P1:<grid>:<level>` e.g. `P1:C-5:L3`, `P1:C-6:L3`, `P1:B-4:L3`, `P1:ZoneB:L3`, `P1:Slab:L4`.
- Drawing `A-102` "Column Reinforcement Details — Level 3":
  - `A-102@R3` issued 2026-07-20, status Superseded, column rebar_spacing C-5 = 200 mm
  - `A-102@R4` issued 2026-08-12, For Construction, is_latest=1, C-5 rebar_spacing = 180 mm (tol ±10), C-6 = 180 mm, cover 40 mm (IS 456 Cl. 26.4)
  - `RFI-047` "Column C-5 stirrup spacing clarification" → Answered 2026-08-10 → resulting_drawing_id `A-102@R4`
- Drawing `S-301` "Level 4 Slab GA": `S-301@R2` For Construction, slab thickness 150 mm.
- Permit `HWP-0112` hot_work at `P1:ZoneB:L3`, Active, fire-watch check **unsatisfied**.
- Pre-pour checklist (QC-CON-CHK-001) for L4 slab — hold point **not released**.
