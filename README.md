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

## Acceptance test
8–10 scripted scenarios with deliberate errors + barge-in. Pass = zero observations logged with wrong drawing
ref or dimension; every contradiction produced a spoken clarification. (`data/seed/scenarios.json`, runner in `app/`.)

## Layout
```
data/schema.sql          SQLite schema (shared contract)
data/scraper/            Firecrawl scraper for infralens.in (Formats 100, QA/QC 300, PMC 150)
data/seed/               Demo project (drawings, facts, RFIs, BOQ, permits) + scenarios.json
data/site.db             Built database (python3 data/build_db.py)
landing/index.html       Marketing landing page
app/                     Mobile-first voice app (Next.js) — Rime TTS + Web Speech ASR + contradiction engine
.env                     FIRECRAWL_API_KEY, RIME_API_KEY, ANTHROPIC_API_KEY (never commit)
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
