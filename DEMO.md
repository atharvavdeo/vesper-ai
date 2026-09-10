# Vesper — demo script (live mic, ~3 min)

The point: **the agent already knows this site.** It opens by referring to yesterday's work
and what's blocked, you continue the conversation from there, and every number it says comes
out of the project database — never invented.

## Before you start

```bash
python3 data/build_db.py     # clean baseline (2 seed observations, 5 DPRs, 10 RFIs)
./run-all.sh                 # voiceid :8788 · backend :8000 · frontend :3000
cd agent && ./run.sh         # the LiveKit voice agent (separate terminal)
curl -s localhost:8000/api/health
```
Open **http://localhost:3000** in Chrome. Go to **Enroll**, record 3 samples of your voice
(this is what the speaker gate checks against). Then **Live**.

## The site, as of the demo

Tower B, Residential G+12, Hinjewadi Pune. Latest site day **9 Sep 2026**.
- L4 slab pre-pour is on **HOLD** (`CL-PP-L4-001`) — cover shortfall at 3 spots, **RFI-050** open
- Hot-work permit **HWP-0112** at Zone B L3 is Active but the **fire-watch checks are unsatisfied**
- `A-102` is at **R4** (12 Aug, via **RFI-047**) — C-5 rebar spacing **180 mm ±10**
- `S-301` is at **R2** — L4 slab thickness **150 mm ±5** (R1 said 125)

---

## Script

### 0:00 — It opens with memory, not a menu
Click **Start conversation** → **Tap to enable audio**.

It greets you with the real state of the job — something like *"Yesterday you were on L4 slab
top bars and the pre-pour is still on hold over the cover shortfall, RFI fifty is open. What
are you looking at?"*

> Say out loud: "Notice it didn't ask me who I am or what project this is. It read the last
> three daily progress reports, the open RFIs and the hold points before it said a word."

Point at the **Site memory** panel — that's exactly what it's working from.

### 0:30 — Ask it about the past
> **"Why is the L4 slab pour on hold?"**

It calls `recall`, and answers from the DPRs + RFIs + submittals: cover shortfall at three
locations, RFI-050 conduit reroute still open, consultant release pending, SUB-004 method
statement under review.

> **"What did we do on C-5?"**

Cage completed 6 Sep with ties at 180 c/c, poured 8 Sep, RFI-047 was the clarification that
moved A-102 to R4.

### 1:15 — The core feature: it challenges you
> **"Column C-5, rebar spacing one eighty millimetres, drawing A-102 revision three."**

It stops you: A-102's latest For-Construction revision is **R4**, issued 12 August, driven by
**RFI-047**; R3 is superseded. Your 180 matches R4 — the *revision reference* is what's stale.

> **"Log it."**

Logged. Open the **Logs** tab: the row is linked to **A-102@R4** — never R3 — with
`revision_claimed: R3` preserved as what you actually said.

> Say out loud: "It logged what I observed, against the drawing that's actually in force."

### 2:00 — It refuses when the site is unsafe
> **"There's welding going on at Zone B level 3, everything looks fine, log it as OK."**

It blocks: permit **HWP-0112** is active but the fire-watch checks are unsatisfied — a fire
watcher isn't assigned, and post-work fire watch isn't covered. Only *stop work / raise NCR /
cancel* are allowed. A "work OK" observation is never written.

> **"Stop the work then."**

Logged as `stop_work`.

### 2:40 — Interrupt it
Start a new observation and **talk over it mid-sentence** — it stops instantly and follows you.
That's the barge-in path (silero VAD + LiveKit turn detection).

### 2:50 — Proof it isn't cherry-picked
**Scenarios** tab → **Run all** → **10 / 10 PASS**, *wrong drawing/dimension/location logs: 0*.

> "Ten scripted site conversations, including deliberate errors and mid-sentence corrections.
> Every contradiction was spoken before anything was logged, and nothing was ever logged
> against the wrong revision."

---

## If someone asks "is the LLM making this up?"

No. The LLM only phrases. Every drawing number, revision, date, RFI and measurement comes from
a tool result: `check_observation` runs the deterministic engine (`backend/engine/`) against
`data/site.db`; `recall` queries project history. `persist.py` re-verifies before every write —
it refuses to log a superseded drawing, an unknown location, or an unconfirmed critical field.

## Voice / speaker gate

Every ~4 s the agent verifies the live mic against your enrolled voiceprint (SpeechBrain
ECAPA-TDNN, running locally in `voiceid/`). If someone else speaks, the logging tools refuse —
the conversation continues, but nothing gets written. Demo it by having a colleague say
"log it".

## Fallbacks if the room is noisy

- Threshold too tight/loose → `SPEAKER_ID_THRESHOLD` in `.env`
- Reset between rehearsals → `python3 data/build_db.py`, then restart the backend and agent
  (both hold a SQLite connection)
