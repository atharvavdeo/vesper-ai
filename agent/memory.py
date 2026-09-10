"""Project memory — everything the agent knows about what has already happened on site.

Backed by data/site.db (SQLite, the same DB the contradiction engine reads). Two jobs:

  site_brief(repo)     a short factual situation report, injected into the agent's system
                       prompt at session start so it opens the conversation already knowing
                       the project, yesterday's work, open RFIs and what is blocked.

  recall(repo, query)  targeted lookup across REAL PROJECT HISTORY — past observations,
                       daily progress reports, RFIs, submittals, permits, drawing revisions
                       — before falling back to the scraped template library.

Project rows are ranked ahead of template chunks: the 550 scraped QA/QC templates otherwise
swamp FTS results (a search for "fire watch" would return vendor-empanelment boilerplate).
"""
from __future__ import annotations

import re

_STOP = {
    "the", "and", "was", "were", "did", "does", "what", "when", "where", "which", "who",
    "for", "with", "that", "this", "from", "about", "our", "you", "your", "any", "all",
    "kya", "hai", "tha", "the", "pe", "par", "mein", "ka", "ki", "ke", "hua", "kiya",
    "last", "previous", "before", "earlier", "again", "tell", "show", "give", "much",
}


def _terms(q: str) -> list[str]:
    words = re.findall(r"[A-Za-z0-9][A-Za-z0-9\-/]*", (q or "").lower())
    return [w for w in words if len(w) > 2 and w not in _STOP]


def _like(repo, sql: str, terms: list[str], cols: list[str], args_head: tuple = (),
          limit: int = 6, order: str = ""):
    """OR a LIKE across `cols` for every term, then rank rows by how many terms they hit."""
    if not terms:
        return []
    clauses, args = [], list(args_head)
    for t in terms:
        for c in cols:
            clauses.append(f"{c} LIKE ?")
            args.append(f"%{t}%")
    try:
        rows = repo._all(f"{sql} AND ({' OR '.join(clauses)}) {order}", tuple(args))
    except Exception:
        return []

    def score(r: dict) -> int:
        blob = " ".join(str(v).lower() for v in r.values() if v is not None)
        return sum(blob.count(t) for t in terms)

    rows.sort(key=score, reverse=True)
    return rows[:limit]


_TEMPORAL = re.compile(
    r"\b(yesterday|today|kal|aaj|recent|latest|last (week|few days|couple)|so far|"
    r"this week|progress|update|status|where (are|do) we|catch me up|briefing|summary)\b",
    re.I)


# --------------------------------------------------------------------- brief
def site_brief(repo) -> dict:
    """Situation report. Small enough to sit in a system prompt."""
    pid = repo.project_id
    g = lambda sql, a=(): repo._all(sql, a)  # noqa: E731

    project = (g("SELECT name, client, location, contract_type, start_date "
                 "FROM projects WHERE project_id = ?", (pid,)) or [{}])[0]

    recent_logs = g(
        "SELECT log_date, weather, substr(work_done,1,220) AS work_done, "
        "substr(safety_incidents,1,140) AS safety "
        "FROM daily_logs WHERE project_id = ? ORDER BY log_date DESC LIMIT 3", (pid,))

    recent_obs = g(
        "SELECT observation_id, substr(created_at,1,10) AS on_date, location_id, element, "
        "attribute, value_claimed, unit, drawing_id, final_decision "
        "FROM field_observations WHERE project_id = ? ORDER BY created_at DESC LIMIT 5", (pid,))

    open_rfis = g(
        "SELECT rfi_id, subject, location_id, drawing_ref, status, impact "
        "FROM rfis WHERE project_id = ? AND status IN ('Open','Answered') "
        "ORDER BY CASE status WHEN 'Open' THEN 0 ELSE 1 END, rfi_id", (pid,))

    permits = g(
        "SELECT permit_id, permit_type, location_id, status FROM permits "
        "WHERE project_id = ? AND status IN ('Active','Suspended')", (pid,))
    for p in permits:
        p["unsatisfied_mandatory_checks"] = [
            r["label"] for r in g(
                "SELECT label FROM permit_checks WHERE permit_id = ? "
                "AND is_mandatory = 1 AND satisfied = 0", (p["permit_id"],))]

    hold_points = g(
        "SELECT instance_id, template_id, location_id, element, planned_activity, "
        "planned_for, status, notes FROM checklist_instances "
        "WHERE project_id = ? AND status != 'Released'", (pid,))

    pending_submittals = g(
        "SELECT submittal_id, material, status, substr(reviewer_comments,1,120) AS comments "
        "FROM submittals WHERE project_id = ? AND status IN ('Under Review','Rejected')", (pid,))

    latest_drawings = g(
        "SELECT drawing_number, revision, substr(issued_on,1,10) AS issued_on, title "
        "FROM v_latest_drawings WHERE project_id = ? ORDER BY drawing_number", (pid,))

    return {
        "project": project,
        "today_is": g("SELECT MAX(log_date) AS d FROM daily_logs WHERE project_id = ?", (pid,))[0]["d"],
        "recent_daily_logs": recent_logs,
        "recent_observations": recent_obs,
        "open_rfis": open_rfis,
        "active_permits": permits,
        "open_hold_points": hold_points,
        "pending_submittals": pending_submittals,
        "current_drawings": latest_drawings,
    }


def brief_text(b: dict) -> str:
    """Compact prose form of site_brief() for the system prompt."""
    p = b.get("project") or {}
    L: list[str] = [
        f"PROJECT: {p.get('name','')} for {p.get('client','')} at {p.get('location','')} "
        f"({p.get('contract_type','')}, started {p.get('start_date','')}). Latest site day: {b.get('today_is')}."
    ]

    logs = b.get("recent_daily_logs") or []
    if logs:
        L.append("RECENT WORK (daily progress reports, newest first):")
        for d in logs:
            L.append(f"  - {d['log_date']}: {d['work_done']}"
                     + (f" | Safety: {d['safety']}" if d.get("safety") else ""))

    obs = b.get("recent_observations") or []
    if obs:
        L.append("RECENT LOGGED OBSERVATIONS:")
        for o in obs:
            val = f"{o['attribute']} {o['value_claimed']}{o['unit'] or ''}" if o.get("attribute") else ""
            L.append(f"  - {o['observation_id']} ({o['on_date']}) {o['location_id']} "
                     f"{o.get('element') or ''} {val} vs {o.get('drawing_id')} [{o['final_decision']}]")

    rfis = b.get("open_rfis") or []
    if rfis:
        L.append("RFIs still live:")
        for r in rfis:
            L.append(f"  - {r['rfi_id']} [{r['status']}] {r['subject']} @ {r.get('location_id')}"
                     + (f" — {r['impact']}" if r.get("impact") else ""))

    for pm in b.get("active_permits") or []:
        un = pm.get("unsatisfied_mandatory_checks") or []
        L.append(f"PERMIT {pm['permit_id']} ({pm['permit_type']}) at {pm['location_id']} is {pm['status']}"
                 + (f" — UNSATISFIED mandatory checks: {'; '.join(un)}" if un else " — all checks satisfied"))

    for h in b.get("open_hold_points") or []:
        L.append(f"HOLD POINT {h['instance_id']} at {h['location_id']} ({h['planned_activity']} "
                 f"planned {h['planned_for']}) is {h['status']} — {h.get('notes') or ''}")

    subs = b.get("pending_submittals") or []
    if subs:
        L.append("SUBMITTALS not cleared: " + "; ".join(
            f"{s['submittal_id']} {s['material']} [{s['status']}]" for s in subs))

    dwg = b.get("current_drawings") or []
    if dwg:
        L.append("CURRENT For-Construction drawings: " + ", ".join(
            f"{d['drawing_number']} {d['revision']} ({d['issued_on']})" for d in dwg))

    return "\n".join(L)


# --------------------------------------------------------------------- recall
def recall(repo, query: str, limit: int = 5) -> dict:
    """Search real project history first, template library only as a fallback."""
    q = (query or "").strip()
    pid = repo.project_id
    out: dict = {"query": q, "observations": [], "daily_logs": [], "rfis": [],
                 "submittals": [], "permits": [], "drawings": [], "reference_docs": []}
    if not q:
        return out
    t = _terms(q)

    # "what happened yesterday" / "catch me up" — no useful keywords, answer with recency
    if _TEMPORAL.search(q):
        out["daily_logs"] = repo._all(
            "SELECT log_date, weather, substr(work_done,1,260) AS work_done, "
            "substr(safety_incidents,1,160) AS safety_incidents FROM daily_logs "
            "WHERE project_id = ? ORDER BY log_date DESC LIMIT 3", (pid,))
        out["observations"] = repo._all(
            "SELECT observation_id, substr(created_at,1,16) AS at, location_id, element, attribute, "
            "value_claimed, unit, drawing_id, final_decision, spoken_text FROM field_observations "
            "WHERE project_id = ? ORDER BY created_at DESC LIMIT 3", (pid,))
        out["rfis"] = repo._all(
            "SELECT rfi_id, subject, status, location_id, drawing_ref, impact FROM rfis "
            "WHERE project_id = ? AND status = 'Open' ORDER BY rfi_id", (pid,))
        if not t:
            return out

    out["observations"] = out["observations"] or _like(
        repo,
        "SELECT observation_id, substr(created_at,1,16) AS at, location_id, element, attribute, "
        "value_claimed, unit, drawing_id, final_decision, contradiction_kinds, spoken_text "
        "FROM field_observations WHERE project_id = ?",
        t, ["location_id", "element", "attribute", "spoken_text", "drawing_id",
            "structured_summary", "final_decision"], (pid,), limit,
        order="ORDER BY created_at DESC")

    out["daily_logs"] = out["daily_logs"] or _like(
        repo,
        "SELECT log_date, weather, substr(work_done,1,260) AS work_done, "
        "substr(safety_incidents,1,160) AS safety_incidents FROM daily_logs WHERE project_id = ?",
        t, ["work_done", "safety_incidents", "log_date", "materials_json", "equipment_json"],
        (pid,), limit, order="ORDER BY log_date DESC")

    out["rfis"] = out["rfis"] or _like(
        repo,
        "SELECT rfi_id, subject, status, location_id, drawing_ref, question, response, impact, "
        "raised_on, answered_on FROM rfis WHERE project_id = ?",
        t, ["rfi_id", "subject", "question", "response", "location_id", "drawing_ref", "impact"],
        (pid,), limit, order="ORDER BY CASE status WHEN 'Open' THEN 0 WHEN 'Answered' THEN 1 ELSE 2 END")

    out["submittals"] = _like(
        repo,
        "SELECT submittal_id, type, material, status, reviewer_comments, submitted_on "
        "FROM submittals WHERE project_id = ?",
        t, ["material", "type", "status", "reviewer_comments"], (pid,), limit)

    out["permits"] = _like(
        repo,
        "SELECT permit_id, permit_type, location_id, status, valid_from, valid_to "
        "FROM permits WHERE project_id = ?",
        t, ["permit_id", "permit_type", "location_id", "status"], (pid,), limit)

    out["drawings"] = _like(
        repo,
        "SELECT drawing_id, drawing_number, revision, status, substr(issued_on,1,10) AS issued_on, "
        "title, change_note FROM drawings WHERE project_id = ?",
        t, ["drawing_number", "title", "change_note", "discipline"], (pid,), limit)

    # spec / code / template reference — only if the project rows gave us little
    if sum(len(v) for k, v in out.items() if isinstance(v, list)) < 3:
        fts = " OR ".join(t) or q
        try:
            out["reference_docs"] = repo._all(
                "SELECT doc_type, doc_ref, substr(content,1,200) AS snippet "
                "FROM doc_chunks_fts WHERE doc_chunks_fts MATCH ? LIMIT ?", (fts, 3))
        except Exception:
            pass
    return out
