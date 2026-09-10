"""Deterministic answers to site QUESTIONS ("what is the cover at E-1?", "and at E-2?").

The observation flow (dialogue.py) asks for missing fields until it can check a claim. A
question has no claim to check, so routing it through that flow produced a follow-up prompt
("what is the cover? give it in mm") instead of an answer. This module answers from the
same SQLite record: latest For-Construction facts, open hold points / permits / RFIs at the
location, and project memory as a fallback. Nothing here writes.
"""
from __future__ import annotations

import re

from . import memory
from .replies import attr_label, level_label, spoken_date

_Q_WORDS = re.compile(
    r"^(what|whats|which|how|when|where|who|why|is|are|was|were|does|do|did|can|could|should|"
    r"will|tell|show|give|list|check|any|kya|kitna|kitni|kitne|kaun|kaunsa|kaunsi|kab|kahan|"
    r"batao|bataiye|bata|and|what about|how about)\b")
_Q_ANYWHERE = re.compile(
    r"\?|\b(kya hai|kitna hai|kitni hai|kya tha|batao|bataiye|required|should be|as per (the )?drawing|"
    r"what about|how about|status of|latest (drawing|revision)|any (open|pending)|is there|are there)\b")


NOT_FOUND = "I could not find that in the project record. Give me a grid line, drawing number or RFI."


def is_question(raw: str, ex) -> bool:
    """A question asks for the record; it does not assert a measured value or a decision."""
    t = (ex.normalized or raw or "").strip().lower()
    if not t or ex.decision or ex.affirm or ex.deny:
        return False
    if ex.value and not re.search(r"\b(should|required|as per|allowed|ok|okay|within)\b", t):
        return False  # "E-1 cover 30 mm" is an observation, even with a trailing "?"
    return bool(_Q_WORDS.search(t) or _Q_ANYWHERE.search(t))


def _num(v):
    return int(v) if isinstance(v, float) and v.is_integer() else v


def _loc_name(loc: dict) -> str:
    head = loc.get("grid") or loc.get("zone") or loc["location_id"].split(":")[1]
    lvl = level_label(loc.get("level"))
    return f"{head}, {lvl}" if lvl else head


def _fact_line(f: dict) -> str:
    val = _num(f.get("value_num")) if f.get("value_num") is not None else f.get("value_text")
    tol = _num(f.get("tolerance"))
    s = f"{f.get('element') or ''} {attr_label(f['attribute'])} is {val}{(' ' + f['unit']) if f.get('unit') else ''}"
    if tol:
        s += f" plus or minus {tol}"
    s += f", per {f['drawing_number']} {f['revision']}"
    if f.get("issued_on"):
        s += f" issued {spoken_date(f['issued_on'])}"
    if f.get("via_rfi"):
        s += f" after {f['via_rfi']}"
    if f.get("code_ref"):
        s += f" ({f['code_ref']})"
    return s.strip()


def answer(repo, raw: str, ex, ctx: dict) -> dict:
    """Return {text, facts, location_id, context}. `ctx` carries the previous question so a
    follow-up like "and at E-2?" or "what about thickness?" keeps the missing half."""
    sv = lambda k: (getattr(ex, k) or {}).get("value") if getattr(ex, k, None) else None  # noqa: E731
    grid, zone, level = sv("grid"), sv("zone"), sv("level")
    element, attribute = sv("element"), sv("attribute")
    if not (grid or zone or (element == "slab" and level)):
        grid, zone = grid or ctx.get("grid"), zone or ctx.get("zone")
        level = level or ctx.get("level")
    attribute = attribute or (ctx.get("attribute") if (grid or zone) and not _asks_everything(raw) else None)
    element = element or ctx.get("element") if attribute else element
    new_ctx = {"grid": grid, "zone": zone, "level": level, "element": element, "attribute": attribute}

    locs = repo.resolve_location({"grid": grid, "zone": zone, "level": level, "element": element})
    facts: list[dict] = []
    loc = None
    for cand in locs:
        rows = (repo.current_facts(cand["location_id"], attribute, element)
                or (repo.current_facts(cand["location_id"], attribute) if attribute else [])
                or ([] if attribute else repo.current_facts(cand["location_id"])))
        if attribute == "stirrup_spacing" and not rows:
            rows = repo.current_facts(cand["location_id"], "rebar_spacing")
        if rows:
            loc, facts = cand, rows
            break
    loc = loc or (locs[0] if len(locs) == 1 else None)

    parts: list[str] = []
    topic = _topic(raw)
    if topic and not loc and not ex.attribute:
        text = _topic_answer(repo, topic)
        return {"text": text, "facts": [], "location_id": None, "context": dict(ctx), "resolved": True}
    if loc:
        name = _loc_name(loc)
        items = _open_items(repo, loc["location_id"])
        if attribute:
            # a specific question gets its answer first; open items follow as a short aside
            if facts:
                parts.append(f"At {name}: " + "; ".join(_fact_line(f) for f in facts[:2]) + ".")
            else:
                parts.append(f"I have no {attr_label(attribute)} on any current drawing for {name}.")
            parts += items[:1]
        else:
            # a general "what should I check" leads with blockers: that is what must be acted on
            parts += items
            if facts:
                n = 2 if items else 3
                parts.append(f"At {name}: " + "; ".join(_fact_line(f) for f in facts[:n]) + ".")
                if len(facts) > n:
                    parts.append(f"{len(facts) - n} more checks are on record here.")
        if not parts:
            parts.append(f"Nothing open at {name}, and no drawing facts are recorded there.")
    elif len(locs) > 1:
        lv = " or ".join(sorted({level_label(l.get('level')) for l in locs if l.get("level")}))
        parts.append(f"{grid or zone} exists on more than one level — {lv}. Which one?")
    elif ex.drawingNumber:
        dn = repo.resolve_drawing_number(ex.drawingNumber["value"])
        latest = repo.latest_drawing(dn) if dn else None
        if latest:
            rfi = repo.rfi_for_drawing(latest["drawing_id"])
            parts.append(f"The latest For Construction revision of {dn} is {latest['revision']}, issued "
                         f"{spoken_date(latest.get('issued_on'))}" + (f", driven by {rfi['rfi_id']}" if rfi else "")
                         + (f". {latest['title']}." if latest.get("title") else "."))
        else:
            parts.append(f"Drawing {ex.drawingNumber['value']} is not in the register.")
    else:
        parts.append(_from_memory(repo, raw))

    text = " ".join(p for p in parts if p).strip()
    return {"text": text, "facts": [f["fact_id"] for f in facts[:3]] if facts else [],
            "location_id": loc["location_id"] if loc else None, "context": new_ctx,
            "resolved": text != NOT_FOUND}


_TOPICS = [
    ("rfi", re.compile(r"\brfis?\b")),
    ("hold", re.compile(r"\bhold[- ]?points?\b")),
    ("permit", re.compile(r"\bpermits?\b")),
    ("submittal", re.compile(r"\bsubmittals?\b")),
    ("drawing", re.compile(r"\b(drawings|drawing register|revisions)\b")),
    ("today", re.compile(r"\b(today|yesterday|progress|status|catch me up|summary|kal|aaj)\b")),
]


def _topic(raw: str) -> str | None:
    t = raw.lower()
    for name, rx in _TOPICS:
        if rx.search(t):
            return name
    return None


def _topic_answer(repo, topic: str) -> str:
    pid = repo.project_id
    if topic == "rfi":
        rows = repo._all("SELECT rfi_id, subject FROM rfis WHERE project_id = ? AND status = 'Open' ORDER BY rfi_id", (pid,))
        return ("Open RFIs: " + "; ".join(f"{r['rfi_id']}, {r['subject']}" for r in rows[:4]) + "."
                if rows else "There are no open RFIs.")
    if topic == "hold":
        rows = repo._all("SELECT instance_id, location_id, planned_activity, notes FROM checklist_instances "
                         "WHERE project_id = ? AND status != 'Released'", (pid,))
        return (" ".join(f"Hold point {r['instance_id']} at {r['location_id'].split(':', 1)[1]} for "
                         f"{r['planned_activity']} is not released: {r.get('notes') or ''}".strip() for r in rows)
                if rows else "No hold points are open.")
    if topic == "permit":
        rows = repo._all("SELECT permit_id, permit_type, location_id, status FROM permits "
                         "WHERE project_id = ? AND status IN ('Active','Suspended')", (pid,))
        out = []
        for p in rows:
            un = [r["label"] for r in repo._all("SELECT label FROM permit_checks WHERE permit_id = ? AND "
                                                  "is_mandatory = 1 AND satisfied = 0", (p["permit_id"],))]
            out.append(f"{p['permit_id']} {p['permit_type'].replace('_', ' ')} at {p['location_id'].split(':', 1)[1]} "
                       f"is {p['status'].lower()}" + (f", {len(un)} mandatory checks pending" if un else ", all checks done"))
        return ("; ".join(out) + ".") if out else "No active permits."
    if topic == "submittal":
        rows = repo._all("SELECT submittal_id, material, status FROM submittals WHERE project_id = ? "
                         "AND status IN ('Under Review','Rejected')", (pid,))
        return ("Not cleared: " + "; ".join(f"{r['submittal_id']} {r['material']}, {r['status'].lower()}" for r in rows) + "."
                if rows else "All submittals are cleared.")
    if topic == "drawing":
        rows = repo._all("SELECT drawing_number, revision FROM v_latest_drawings WHERE project_id = ? "
                         "ORDER BY drawing_number", (pid,))
        return "Current For Construction drawings: " + ", ".join(f"{r['drawing_number']} {r['revision']}" for r in rows) + "."
    b = memory.site_brief(repo)
    logs = b.get("recent_daily_logs") or []
    head = f"On {logs[0]['log_date']}: {logs[0]['work_done']}" if logs else "No daily report yet."
    return head


def _asks_everything(raw: str) -> bool:
    return bool(re.search(r"\b(everything|all|status|open|pending|anything)\b", raw.lower()))


def _open_items(repo, location_id: str) -> list[str]:
    out: list[str] = []
    for hp in repo.hold_point_blockers(location_id):
        items = "; ".join(i["label"] for i in hp["items"][:2])
        out.append(f"Hold point {hp['ref']} is not released: {items}.")
    for p in repo._all("SELECT permit_id, permit_type, status FROM permits WHERE location_id = ? "
                       "AND status IN ('Active','Suspended')", (location_id,)):
        un = [r["label"] for r in repo._all(
            "SELECT label FROM permit_checks WHERE permit_id = ? AND is_mandatory = 1 AND satisfied = 0",
            (p["permit_id"],))]
        if un or p["status"] == "Suspended":
            out.append(f"Permit {p['permit_id']} ({p['permit_type'].replace('_', ' ')}) is {p['status'].lower()}"
                       + (f", pending: {'; '.join(un[:2])}." if un else "."))
    rfis = repo._all("SELECT rfi_id, subject FROM rfis WHERE location_id = ? AND status = 'Open'", (location_id,))
    if rfis:
        out.append("Open " + ", ".join(f"{r['rfi_id']} ({r['subject']})" for r in rfis[:2]) + ".")
    return out


def _from_memory(repo, raw: str) -> str:
    hit = memory.recall(repo, raw, limit=3)
    if hit.get("current_facts"):
        f = hit["current_facts"][0]
        return (f"{f['location_id'].split(':')[1]}: {f['element']} {attr_label(f['attribute'])} is "
                f"{_num(f['value'])} {f.get('unit') or ''} per {f['drawing']}.").replace(" .", ".")
    if hit.get("rfis"):
        r = hit["rfis"][0]
        return f"{r['rfi_id']} — {r['subject']} — is {str(r['status']).lower()}." + (
            f" {r['impact']}." if r.get("impact") else "")
    if hit.get("observations"):
        o = hit["observations"][0]
        return f"Last related log was {o['observation_id']} on {str(o['at'])[:10]}: {o.get('spoken_text') or ''}"
    if hit.get("daily_logs"):
        d = hit["daily_logs"][0]
        return f"On {d['log_date']}: {d['work_done']}"
    if hit.get("drawings"):
        d = hit["drawings"][0]
        return f"{d['drawing_number']} {d['revision']} ({d['status']}), issued {spoken_date(d.get('issued_on'))}."
    if hit.get("reference_docs"):
        return f"From {hit['reference_docs'][0]['doc_ref']}: {hit['reference_docs'][0]['snippet']}"
    return NOT_FOUND
