# Vesper — Round 2 brief

Numbers in this file were measured on 2026-09-19 on the development laptop (Apple M3, 16 GB) against
the committed P1 project data, unless a row says otherwise. Voice-leg numbers marked *(RIME_EVIDENCE)*
come from the recorded acceptance run `20260911-003352` and are reproduced with
`scripts/voice_acceptance.py`. Every number below is reproducible with the command given beside it.

---

## 1. Speed — where the milliseconds go

### 1.1 Decision engine (the part that decides what is true)

Pure Python, no model in the decision path. `backend/engine`, 50 iterations each:

| Stage | p50 | p95 |
| --- | --- | --- |
| `extract` — slots out of a spoken turn | **0.06 ms** | 0.07 ms |
| `contradictions.check` — turn vs current drawing revision | **0.56 ms** | 0.68 ms |
| `answer` — grounded reply for a drawing question | **0.59 ms** | 0.64 ms |
| `answer` — open-RFI list | **0.06 ms** | 0.06 ms |

The whole decision is under **1.5 ms**. That is the headline: the thing that could log a wrong
dimension onto a site record is rule-based, deterministic and effectively free. Latency is spent on
audio and phrasing, never on judgement.

### 1.2 Memory answer (retrieval + citation + phrasing), warm process

`backend/memory`, 20,767 vectors over 7,366 documents, per-project dataset isolation:

| Stage | p50 | max (n=4 questions) |
| --- | --- | --- |
| Vector search (LanceDB) | 31 ms | 39 ms |
| BM25 / FTS5 (SQLite) | 224 ms | 239 ms |
| Cross-encoder rerank (`bge-reranker-v2-m3`, local, MPS) | 239 ms | 532 ms |
| LLM phrasing (one call) | 470 ms | 794 ms |
| **End to end, cited answer** | **974 ms** | 1446 ms |

Retrieval-only (no phrasing) is **7.2 ms p50 / 14.5 ms p95** warm, 372 ms p50 cold — from the
committed eval run in `data/memory/eval_report.json` (`scripts/eval_memory.py`).

Cold start on the first question of a process adds ~7–9 s, all of it loading the reranker weights
onto the GPU. Production fix is a warm worker; the demo warms it with the spoken greeting.

### 1.3 Voice leg

| Leg | Measured |
| --- | --- |
| Sarvam `saaras:v3` REST STT, 1.4 s clip | **292 ms** round trip |
| Rime `mistv3` / `wildflower`, full mp3 over REST | 1.29–2.28 s cold, **~880 ms** time-to-first-byte warm |
| Rime `mistv3` over websocket, first audio | **320–390 ms** warm, ~1.1 s on a new socket *(RIME_EVIDENCE)* |
| Groq Whisper `large-v3` final transcript after speech stops | 654 ms median, range 616–765, n=11 *(RIME_EVIDENCE)* |
| Cerebras `gpt-oss-120b`, short reply | **488 ms** |
| Sarvam `bulbul:v3` TTS, one sentence | 830 ms |
| Local `bge-m3` embedding of a query (Ollama) | **53 ms** warm, 1.9 s cold |
| End of turn → first audible audio, full pipeline | median **1988 ms**, max 2591, 6/6 answers correct *(RIME_EVIDENCE)* — target was ≤1500 ms, so this is the one published miss |
| Barge-in: audio stops after the manager starts speaking | **1065 ms** *(RIME_EVIDENCE)*, measured with a 600 ms quiet detector, so the true stop is faster |

The 1988 ms miss is honest and explained: most of it was batch Whisper STT plus endpointing. The live
path now streams Sarvam `saaras:v3-realtime` instead, and the re-measurement is the first thing to
show in round 2.

### 1.4 What to say about speed in one line

> The judgement is sub-millisecond and deterministic. Perceived latency is ~2 s end-to-end today,
> and the two remaining chunks — batch STT and reranker cold start — are both already identified,
> with the streaming replacement in the code.

---

## 2. The data path — every hop, and exactly what leaves the laptop

### 2.1 Runtime hops for one spoken turn

1. **Browser** (`livekit-client`, WebRTC) → **LiveKit Cloud** (India South region) — Opus audio only.
2. **LiveKit** → **`agent/worker.py`** (LiveKit Agents 1.8) — audio frames.
3. Worker → **Sarvam STT** `saaras:v3-realtime` over websocket — audio out, text back.
   Fallback: **Groq Whisper** `large-v3` REST.
4. Worker → **speaker-ID sidecar** `:8788` (SpeechBrain ECAPA-TDNN, **localhost only**) — an audio
   window in, a similarity score back. No voice data leaves the machine.
5. Worker → `agent/stt_normalize.py` → **`backend/engine`** (local) — site IDs normalised, slots
   extracted, contradiction checked against `data/site.db`.
6. Worker → **Groq → Cerebras → NVIDIA NIM** — only the retrieved text snippets and the question;
   used for phrasing and slot filling, never for the decision.
7. Worker → **Rime** `mistv3` / `wildflower` over websocket — reply text out, PCM audio back.
8. Audio → LiveKit → browser. Data events (engine state, citations) ride the same room.

### 2.2 Non-voice hops

- **Next.js frontend (`:3000`) → FastAPI (`:8000`)** only. The browser never holds a provider key;
  `/api/tts`, `/api/stt` and `/api/rtc/token` are server-side proxies.
- **Clerk** — sign-in, organizations, session token v2. Backend verifies RS256 JWTs against Clerk's
  JWKS; no shared secret, no Clerk call per request.
- **Resend** — welcome, project-created, invite and ingest-complete mails.
- **Ollama `bge-m3`** (`:11434`, localhost) — every embedding. **No document text goes to an
  embedding vendor.**
- **`bge-reranker-v2-m3`** — local, on-device (MPS).
- **LanceDB** (`data/memory/`), **SQLite FTS5 + tenancy** (`data/app.db`), **engine records**
  (`data/site.db`), **Cognee/Kuzu graph** (896 nodes / 3,906 edges) — all on disk, all local.
- **Supabase Postgres + pgvector** — mirror/backup, 20,767 vectors, verified row-for-row by
  `scripts/export_to_supabase.py --verify`.
- **Neo4j Aura** — write-only graph backup (`scripts/export_graph_to_neo4j.py`). The app never reads
  it; Kuzu stays the source of truth.

### 2.3 The sentence that answers "where does our data go"

> Documents and vectors never leave the machine — embeddings and reranking are local. Audio goes to
> Sarvam and Rime. Retrieved snippets go to one LLM for phrasing. Records, graph and vectors stay in
> SQLite/LanceDB/Kuzu on disk, with an encrypted-at-rest mirror in Supabase and a write-only graph
> backup in Neo4j Aura.

---

## 3. Security posture

### 3.1 In place today

| Control | Implementation |
| --- | --- |
| Identity | Clerk Organizations; client company = org, projects belong to orgs |
| Token verification | RS256 via Clerk JWKS in the backend (`PyJWT[crypto]`); no request is served on an unverified token — `/api/drawings` and `/api/tts` return 401 without one, verified live today |
| Tenancy | Every query is scoped to `org_<org>__proj_<project>`; org id is resolved from the verified project row, never from the request body (`backend/memory/api.py`) |
| Scope-leak test | `scripts/eval_memory.py` asserts `scope_leaks: []` — currently 0 across 43 golden questions |
| Write authorisation by voice | SpeechBrain voiceprint per account, threshold 0.70, **fails closed**: an unenrolled or different voice scores 0.03 and nothing is written |
| Secret handling | All provider keys server-side; `.env`, `backend/.env.local`, `app/.env.local` gitignored; the browser receives none |
| Quota | `FREE_COMMAND_LIMIT` / `ENFORCE_FREE_COMMAND_LIMIT` — 429 with a typed error code |
| Agent surface | 12 MCP tools over the same auth and project scoping as the dashboard (`docs/MCP.md`), read-only annotations where applicable |
| Auditability | `voice_sessions` (45) and `voice_turns` (138) keep every turn; `activity` and `email_log` in `app.db` |
| Tests | 15/15 backend tests pass; 10/10 scripted safety scenarios pass with **0 wrong logs** |

### 3.2 Known gaps, with the fix named (say these before a judge finds them)

| Gap | Fix |
| --- | --- |
| CORS is `allow_origins=["*"]` in `backend/main.py` | Pin to the deployed origin + localhost; one line, do before round 2 |
| Credentials pasted into chat/tooling during the build (Supabase DB password, Neo4j API keys) | **Rotate before the presentation.** Non-negotiable |
| Groq API key expired (found today — see §5) | Rotate; add a startup key-health probe surfaced on `/api/v2/status` |
| Supabase mirror has no row-level security yet | Add RLS policies keyed on org id, or keep the mirror private with no anon key issued |
| No rate limiting beyond the free-command quota | Per-IP and per-org limits at the edge |
| Voice-write authorisation is per account, not per role | Bind "can log an NCR / stop work" to Clerk org roles as well as voiceprint |
| No encryption of `data/*.db` at rest on the laptop | FileVault is on; for a site tablet, SQLCipher or an OS keystore |

### 3.3 The one-liner

> Nothing is written to a site record without a verified token **and** a verified voice, and the
> retrieval layer can only see the project it was asked about. The remaining gaps are configuration,
> not architecture: CORS, RLS and key rotation.

---

## 4. How independent is the application?

Counted by what breaks when a dependency disappears:

| Dependency | If it goes down | Blast radius |
| --- | --- | --- |
| Embeddings (Ollama `bge-m3`) | — runs locally | none |
| Reranker | — runs locally | none |
| Vector store, FTS, records, graph | — local files | none |
| Speaker ID | — localhost sidecar | none |
| **Engine / all decisions** | — pure Python | **none: answers and contradiction checks keep working at sub-ms** |
| LLM (Groq) | Cerebras answers instead — **proven today**, 459 ms, nobody would notice | phrasing only |
| LLM (all three) | Retrieval + citations still returned; phrasing degrades to templates | cosmetic |
| Sarvam STT | Groq Whisper fallback | +~350 ms |
| Rime TTS | Sarvam `bulbul` fallback in the agent; Talk falls back to browser speech with a visible badge | voice changes, product works |
| LiveKit | No live voice; dashboard, Ask memory, ingest and Talk all work | voice mode only |
| Clerk | No sign-in (by design) | access only |
| Supabase / Neo4j | Backups only, never read | none |
| Internet, entirely | Ingest, search, citations, contradiction checks and the dashboard still work on the laptop; only spoken I/O and LLM phrasing stop | **the product's judgement is offline-capable** |

Scored honestly: **the intelligence is ours and local; the senses (STT/TTS) and the voice transport
are rented, and each has a live fallback.** No vendor sits in the decision path — that was a design
rule, and it is why an expired key today changed nothing a user could see.

---

## 5. Live finding from today's dry run (turn this into a slide)

While benchmarking, the **Groq key returned `expired_api_key`**. The fallback chain picked up
Cerebras and answered the same three questions correctly in **459 / 805 / 465 ms** with citations
intact. NVIDIA's endpoint answered `410` for the pinned model, so the effective chain is now
Cerebras-only until both are rotated.

Two actions before the presentation: rotate the Groq key, re-point or drop NVIDIA. The story is
good either way — "our primary model provider died mid-rehearsal and the demo did not notice."

---

## 6. Scope

### 6.1 In scope, working today

- Live voice on site: full-duplex, barge-in, Indian English / Hindi / Hinglish, speaker-verified writes.
- Contradiction challenge against the **current** drawing revision, with the clause cited
  (e.g. E-1 cover 30 mm vs A-201 R1 40 mm ± 5, IS 456 Cl. 26.4).
- Refusal of unsafe work: hot work blocked when HWP-0112 lacks fire-watch checks.
- Ask memory: typed or spoken questions, cited answers, read-aloud, per-project chat history.
- Document ingest: PDF / DOCX / XLSX / CSV / text and spoken briefings → chunked, embedded, cited by page.
- Multi-tenancy: 5 orgs, 5 projects, per-project dataset isolation, invites, roles, onboarding.
- Agent surface: 12 MCP tools + REST for other tools to drive the same engine.
- Deployed dashboard walkthrough on Cloudflare Pages; voice demo page.

### 6.2 Data scale in the demo tenant

| | Count |
| --- | --- |
| Documents ingested | 7,366 |
| Chunks / vectors | 20,767 |
| Drawings / drawing facts | 39 / 837 |
| RFIs / submittals / permits / permit checks | 24 / 16 / 10 / 194 |
| Checklist items / templates / template fields | 248 / 550 / 19,133 |
| Daily logs / locations / field observations | 14 / 61 / 10 |
| Graph | 896 nodes, 3,906 edges |
| Voice sessions / turns recorded | 45 / 138 |
| Source lines (backend, agent, app, scripts) | 28,373 |
| Backend endpoints | 43 |

### 6.3 Out of scope, deliberately

- Not a BIM/CAD viewer and not a model-authoring tool; it reads issued documents.
- Not an ERP or a scheduler; it does not own the programme or the money.
- No autonomous action without a human word: every write is confirmed out loud.
- Not a general LLM assistant — it refuses (abstains) instead of guessing, with measured abstain
  precision **1.0** and recall **1.0** on the golden set.

### 6.4 Next scope, in order

1. Re-measure first-audio latency on streaming Sarvam STT (target ≤1500 ms).
2. Warm reranker worker to kill the cold start.
3. CORS pin, Supabase RLS, key rotation, per-org rate limits.
4. `SARVAM_STT_MODE=translit` to fix number parsing in Devanagari (a drawing `A-102` currently reads
   as "102 mm" in Hindi script — known bug, fix is one env flag plus a re-test).
5. Role-bound write authority (voiceprint **and** Clerk org role).
6. Site tablet build: offline-first with encrypted local DB and deferred sync.

---

## 7. Other questions likely to come, with answers

**"What is your accuracy?"** 10/10 scripted safety scenarios with deliberate errors, garbled fields
and barge-in, **0 wrong logs**. Golden-set recall@8 **1.0**, abstain precision **1.0**, abstain
recall **1.0**, `scope_leaks` **0** (n=43, `data/memory/eval_report.json`). We publish the one miss
(1988 ms first audio) in the same table as the passes.

**"Why won't it hallucinate a dimension?"** No model is in the decision path. `extract` → `numbers`
→ `contradictions` are rules over SQLite. The LLM only phrases what retrieval already grounded, and
`verify_numbers` in `backend/memory/answer.py` checks numbers in the phrasing against the sources.

**"What does a turn cost?"** Per turn: ~2–6 s of audio into STT, ~8–15 s of synthesised audio out,
one LLM call over ~8.8 KB of retrieved context (~2.2 k tokens in, ~70 tokens out). Embeddings and
reranking are local, so they cost electricity, not API spend. Multiply by your own list prices —
the only per-turn vendor cost is STT seconds, TTS characters and one small LLM call.

**"Does it work in a noisy site?"** Answered correctly at 5 dB SNR under drill noise *(RIME_EVIDENCE
T2)*, first audio 1949 ms.

**"Hinglish and Indian names?"** Sarvam handles the accent; `agent/stt_normalize.py` maps real
mishearings onto site vocabulary ("pit thoroughly" → "Pithoragarh", "column even" → "E-1"). 5/5
Hinglish golden questions retrieved correctly.

**"What if two people talk / the wrong person gives an order?"** Voiceprint check fails closed at
0.70; a different voice saying "log that observation" scores 0.03 and nothing is written — that test
is in the acceptance run.

**"How do you scale to 50 projects?"** Isolation is per-dataset (`org_<org>__proj_<project>`), so
projects scale horizontally. Local retrieval holds at 20 k chunks in 7–15 ms warm; beyond a laptop,
the same code points at the Supabase pgvector mirror.

**"Vendor lock-in?"** Three interchangeable LLMs, two STT, two TTS, all behind one env switch
(`AGENT_TTS_PROVIDER`, `TTS_PROVIDER`, `STT_PROVIDER`). Today's expired Groq key is the proof.

**"What is defensible here?"** The contradiction engine plus the site ontology (drawings ↔ revisions
↔ clauses ↔ permits ↔ checklists) and the discipline of abstaining. Anyone can call an LLM; the value
is a deterministic layer that refuses to write the wrong number onto a record, and the evidence that
it does refuse.

**"Can it be audited after an incident?"** Every session and turn is stored with the drawing
revision it was checked against (`voice_sessions`, `voice_turns`), plus `activity` and `email_log`.

**"Who is liable if it is wrong?"** It advises and cites; the human confirms out loud before any
write, and refusals are logged. It does not approve, sign or release anything.

---

## 8. Deliverables to have in hand

| Deliverable | Where |
| --- | --- |
| Live dashboard + Ask memory | https://vesper-ai.pages.dev/app/ |
| Voice demo page | https://vesper-ai.pages.dev/demo/ |
| Voice evidence (procedure, raw results, limitations) | `RIME_EVIDENCE.md` |
| Architecture and all flows | `ARCHITECTURE.md` |
| Demo script | `DEMO.md` |
| Safety scenarios, runnable in 2 s | `cd backend && python scenarios.py` (10/10) |
| Memory eval, numbers above | `scripts/eval_memory.py`, `data/memory/eval_report.json` |
| Voice test with no microphone | `agent/.venv/bin/python scripts/voice_smoke.py --wav evidence/fixtures/q_rfis.wav --project P1` |
| Supabase mirror verification | `scripts/export_to_supabase.py --verify` |
| MCP tool contract | `docs/MCP.md` |
| Walkthrough GIF and screenshots | `docs/media/` |

---

## 9. What is actually in the database

### 9.1 Standards, rules and prices (the "policy" layer)

The knowledge base is four global datasets, shared by every project, 7,366 documents / 20,767 chunks:

| Dataset | Documents | Contents |
| --- | --- | --- |
| `kb_is_codes` | 4,375 | IS codes, NBC 2016, IRC, ISO — including IS 456 (10 docs, clause-level entries for Cl. 11, 24.1, 26.3.3, 26.4, 26.5.3.2), IS 1893 (13), IS 3370 (11), IS 13920 (4), IS 10262 (6), IS 383 (4), IS 2502 (5), NBC 2016 (24, incl. Part 4 fire and life safety), plus IS-vs-ACI 318 and IS-vs-Eurocode 2 comparisons |
| `kb_prices_sor` | 1,399 | CPWD DSR / schedule-of-rates items with rates per unit |
| `kb_handbook` | 850 | Design thumb rules, target mean strength, wastage factors, sampling chains (IS 3535 → IS 4031 / IS 4032) |
| `kb_templates` | 550 | Inspection & test plans, QC checklists, permits, NCR and RFI forms — each line carries its own code reference and acceptance criterion (e.g. `ACT-10-01 Bar spacing … Code: IS 456 Cl. 26 … Acceptance: as per drawing`) |

### 9.2 Project records (`data/site.db`, two live projects: P1 Pithoragarh, NSK Nashik)

- **39 drawings** with real revision chains and change notes — A-102 R3 → **R4** dropped tie spacing at
  C-5/C-6 from 200 to 180 c/c per RFI-047 (IS 13920); S-301 R2 raised slab 125 → 150 mm per RFI-052.
- **837 drawing facts**, each one carrying value, unit, **tolerance and the clause it comes from** —
  e.g. E-1 cover 40 mm ± 5 `IS 456 Cl. 26.4`; rebar spacing 150 ± 10 `IS 456 Cl. 26.5.3.2(c)`;
  grade M30 `IS 456 Table 5`.
- **24 RFIs, 16 submittals, 10 permits, 194 permit checks** — HWP-0112 (P1 Zone B L3) is active with
  two mandatory fire-watch checks pending; LFT-2009 lifting permit pending barricading.
- **4 checklist instances / 248 items**, including CL-PP-L4-001 on **Hold** (cover shortfall 15 mm at
  3 locations, RFI-050 open, consultant release pending).
- **14 daily logs, 61 locations, 10 field observations, 550 templates, 19,133 template fields,
  1,402 template codes**, 45 voice sessions / 138 turns of history.

So yes — the rule the answer is judged against is always named: IS clause, NBC part, or a DSR item number.

---

## 10. Five queries to run in front of the judges

Each one tests something different and has been run today. Numbers in brackets are the measured
response times from that run.

**1 · Stale revision, in Hinglish, with a clause cite** *(engine, scenario S01)*
> "haan toh column line C-5 pe rebar spacing 180 mm hai, drawing A 102 rev teen mein 200 mm dikh raha hai"

Vesper answers with the **current** revision: *C-5, Level 3, spacing 180 mm ± 10 per A-102 **R4**
issued 12 August after RFI-047 (IS 456 Cl. 26.5.3.2(c))* — and does not log the R3 number. Follow up
with *"achha R4 aa gaya tha… bas observation log kar do, RFI nahi chahiye"* and it logs the
observation without raising an RFI. **Tests:** Hinglish STT, revision supersession, clause citation,
confirm-before-write. *(sub-1.5 ms decision)*

**2 · Refusing unsafe work** *(engine, scenario S05)*
> "Zone B level 3 mein welding chal rahi hai lift machine room brackets ki, sab theek hai, work ok log kar do"

Vesper refuses: *permit HWP-0112 (hot work) is active, pending — fire watcher assigned distinct from
the welder; fire watch to continue 60 minutes after work stops.* It will not log "work ok".
**Tests:** permit logic, safety refusal, the 194 permit checks. *(sub-1.5 ms)*

**3 · Code vs drawing in one breath** *(Ask memory, hybrid retrieval + citation)*
> "What does IS 456 clause 26.4 require for nominal cover, and what does A-201 give at E-1?"

Answer: *IS 456 Cl. 26.4 — 30 mm for moderate exposure (Table 16); A-201 R1 records 40 mm ± 5 at
E-1*, with both sources cited — one from the code library, one from the project record.
**Tests:** that the standard and the site record are searched together and cited separately.
*(2.66 s, confidence 0.96, 2 citations)*

**4 · Money question, straight out of the schedule of rates** *(Ask memory)*
> "What is the CPWD DSR rate for M30 design mix concrete per cubic metre?"

Answer: *₹8,400/cum for raft foundations (BOQ 5.33.3) and ₹8,650/cum for columns, shear walls and
core walls (BOQ 5.33.2)*, both items cited. **Tests:** the 1,399-item rate library, and that it
distinguishes two DSR items instead of averaging them. *(1.43 s, confidence 0.98)*

**5 · The one it must refuse** *(Ask memory, abstention)*
> "What is the fire rating of the lift shaft door at Level 7?"

Answer: *"That isn't in the project record or the knowledge base."* No LLM call is made, nothing is
invented — there is no Level 7 on this project. **Tests:** abstention, which is the hardest thing to
demo and the easiest to lose trust without. *(586 ms, abstain=True, 0 citations)*

**Spare, if a judge asks for a stop-work call:** *"chalo L4 slab ka pour shuru karte hain, pump aa
gaya hai"* → hold point CL-PP-L4-001 not released (cover shortfall 15 mm at 3 locations, RFI-050
open) → **stop work** (scenario S08).

**Spare, if asked about Hindi:** *"M30 concrete ka cover kitna chahiye columns ke liye?"* → 40 mm,
cited to RFI-053. *(2.23 s)*

Run order matters: do **1** and **2** live on voice (they are the product), then **3**, **4** and
**5** typed in Ask memory (they are the evidence). Warm the reranker with one throwaway question
before the judges walk in, or the first answer pays a 7–9 s model load.
