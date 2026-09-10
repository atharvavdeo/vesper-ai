# Demo — 3 minutes, live mic

## Before you start
```bash
python3 data/build_db.py           # clean baseline
./run-all.sh                       # voiceid :8788 · backend :8000 · frontend :3000
curl -s localhost:8000/api/health  # expect db/llm/rime/voiceid/engine all truthy
```
Open **http://localhost:3000** in Chrome (mic needs Chrome + localhost).
Go to **Enroll**, record 3 samples, confirm "✅ enrolled". Do a throwaway Talk turn to warm the mic.
Keep the **Observations** and **Scenarios** tabs one tap away.

## Script

**0:00 — framing (spoken, no UI)**
"Site managers don't lack data — they lack someone cross-checking what they *say* against the
drawing register, RFIs and permits *before* it's logged. Vesper is that check, by voice."

**0:20 — S01 · revision mismatch → log**
Tap mic, say:
> "Column line C-5 pe rebar spacing ek sau assi mm hai, drawing A-102 rev teen mein do sau dikh raha hai."

Agent challenges (Hinglish TTS): latest is **A-102 R4**, issued 12 August, spacing **180 mm**,
confirmed by **RFI-047**; R3 is superseded (200). Your 180 matches the latest.
Say: **"Theek hai, observation log kar do, RFI nahi chahiye."**
→ Talk shows "logged". Switch to **Observations** — top row: `P1:C-5:L3 · rebar_spacing 180 mm ·
A-102@R4 · revision_claimed R3 · log_observation`. **The logged drawing is R4, never R3.**

**1:20 — S03 · barge-in self-correction**
Tap mic, start: "Column C-5 pe tie spacing ek sau assi mm, drawing A-102 rev…" — while the agent
starts replying, **talk over it**: "Wait, C-5 nahi, C-6. C-6 pe ek sau assi, R4."
Point out: audio stopped the instant you spoke; the interrupted C-5 capture was dropped.
Say "Haan C-6, log kar do." → Observations shows the row against **C-6**, nothing against C-5.

**2:00 — S05 · hot work blocked**
Tap mic: "Zone B level 3 mein welding chal rahi hai, sab theek hai, work ok log kar do."
Agent refuses (amber card + TTS): permit **HWP-0112** is active but the **fire-watch** check is
unsatisfied — only stop work / NCR / cancel allowed. A "work ok" observation is never written.
Say "Kaam rukwa deta hoon, stop work." → logged as `stop_work`.

**2:40 — proof**
**Scenarios** tab → "Run all" → **10 / 10 PASS**, "wrong drawing/dimension/location logs: 0".
"Every contradiction was spoken before anything was logged, and nothing was ever logged against
the wrong revision."

## If the mic misbehaves (noisy room)
Every turn has a typed box — same pipeline. Use the exact scenario sentences from
`data/seed/scenarios.json`.

## Reset between rehearsals
`python3 data/build_db.py` then restart the backend (`./backend/run.sh`) — it holds one
SQLite connection and won't see a rebuilt file otherwise.
