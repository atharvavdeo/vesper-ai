"""vesper-ai backend API. See backend/CONTRACT.md for the frozen contract."""
from __future__ import annotations

import io
import json
import os
from typing import Any

import httpx
import jwt
from jwt import PyJWKClient
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

import config
import db as dbmod

# --- engine (WS-A). Defensive import so the server still boots for frontend dev. -----
try:
    from engine.dialogue import DialogueSession  # type: ignore
    from engine.llm import make_llm_assist  # type: ignore
    ENGINE_READY = True
except Exception as _e:  # pragma: no cover - scaffold only
    ENGINE_READY = False
    _ENGINE_ERR = repr(_e)

    class DialogueSession:  # minimal stub: echoes, never logs
        def __init__(self, repo, session_id, llm=None, persist_turns=True):
            self.session_id = session_id
            self.state = "capturing"

        def handle(self, *, text="", barge_in=False, noise="none", decision=None, speaker=None):
            return {
                "sessionId": self.session_id, "state": "capturing",
                "reply": {"text": f"(engine not loaded) {text}", "speech": ""},
                "entities": [], "contradictions": [], "blockers": [], "missing": [],
                "allowedDecisions": ["cancel"], "slots": {}, "resolved": {},
                "clarifiedKinds": [], "events": ["engine_stub"],
            }

    def make_llm_assist():
        return None

app = FastAPI(title="vesper-ai backend")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)

_conn = dbmod.connect()
_repo = dbmod.Repo(_conn, config.PROJECT_ID)
_llm = make_llm_assist()
_sessions: dict[str, DialogueSession] = {}


def _user_id(request: Request) -> str:
    """Verify the Clerk session token in deployment; local development has a safe demo identity."""
    if not config.CLERK_JWT_ISSUER:
        return request.headers.get("X-Vesper-User", "local-demo")
    token = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(401, "sign in is required")
    try:
        key = PyJWKClient(f"{config.CLERK_JWT_ISSUER}/.well-known/jwks.json").get_signing_key_from_jwt(token).key
        claims = jwt.decode(token, key, algorithms=["RS256"], issuer=config.CLERK_JWT_ISSUER, options={"verify_aud": False})
    except jwt.PyJWTError as exc:
        raise HTTPException(401, "invalid sign-in token") from exc
    subject = str(claims.get("sub") or "")
    if not subject:
        raise HTTPException(401, "invalid sign-in token")
    return subject


def _reserve_or_limit(request: Request) -> int:
    user_id = _user_id(request)
    if not config.ENFORCE_FREE_COMMAND_LIMIT:
        return 0
    ok, used = dbmod.reserve_command(_repo, user_id, config.FREE_COMMAND_LIMIT)
    if not ok:
        raise HTTPException(429, detail={"code": "free_command_limit_reached", "message": "Your three complimentary Vesper commands are complete.", "limit": config.FREE_COMMAND_LIMIT, "used": used})
    return used


def _stt_error_response(upstream_status: int, detail: str) -> JSONResponse:
    """Translate Groq failures into useful API failures.

    Groq returns 400 for an undecodable WebM (for example, a recording stopped
    before its container has been finalised).  Returning 502 in that case made
    a browser recording problem look like an upstream outage.
    """
    body = {"error": "STT transcription failed", "detail": detail[:300]}
    if upstream_status in (400, 413, 415, 422):
        body["error"] = "invalid or unsupported audio"
        return JSONResponse(body, status_code=422)
    if upstream_status in (401, 403):
        # Do not expose provider authentication diagnostics to browsers.
        return JSONResponse({"error": "STT provider is not configured"}, status_code=503)
    if upstream_status == 429:
        return JSONResponse({"error": "STT provider is temporarily busy"}, status_code=503)
    return JSONResponse(body, status_code=502)


def _session(sid: str) -> DialogueSession:
    s = _sessions.get(sid)
    if not s:
        raise HTTPException(404, "unknown session")
    return s


# ---------------------------------------------------------------- health
@app.get("/api/health")
def health() -> dict:
    voiceid_ok = False
    if config.SPEAKER_ID_ENABLED:
        try:
            r = httpx.get(f"{config.SPEAKER_ID_URL}/health", timeout=1.5)
            voiceid_ok = r.status_code == 200
        except Exception:
            voiceid_ok = False
    return {
        "db": os.path.exists(config.SITE_DB_PATH),
        "llm": config.llm_provider(),
        "rime": config.RIME_ENABLED,
        "voiceid": voiceid_ok,
        "engine": ENGINE_READY,
    }


# ---------------------------------------------------------------- LiveKit room token
@app.post("/api/rtc/token")
async def rtc_token(request: Request) -> dict:
    """Mint a LiveKit access token so the browser can join a room. The agent worker
    joins the same room automatically (dispatched by the LiveKit server)."""
    lk_url = os.getenv("LIVEKIT_URL", "").strip()
    lk_key = os.getenv("LIVEKIT_API_KEY", "").strip()
    lk_secret = os.getenv("LIVEKIT_API_SECRET", "").strip()
    if not (lk_url and lk_key and lk_secret) or lk_url.startswith("<"):
        raise HTTPException(503, "LiveKit not configured (LIVEKIT_URL/API_KEY/API_SECRET)")
    _reserve_or_limit(request)
    try:
        body = await request.json()
    except Exception:
        body = {}
    import uuid as _uuid

    from livekit.api import AccessToken, VideoGrants

    identity = (body or {}).get("identity") or f"manager-{_uuid.uuid4().hex[:8]}"
    room = (body or {}).get("room") or f"{os.getenv('AGENT_ROOM_PREFIX', 'vesper')}-{_uuid.uuid4().hex[:8]}"
    tok = (
        AccessToken(lk_key, lk_secret)
        .with_identity(identity)
        .with_name((body or {}).get("name") or "Site Manager")
        .with_grants(VideoGrants(room_join=True, room=room, can_publish=True, can_subscribe=True))
    )
    return {"url": lk_url, "token": tok.to_jwt(), "room": room, "identity": identity}


# ---------------------------------------------------------------- STT (Groq Whisper fallback)
@app.post("/api/stt")
async def stt(file: UploadFile = File(...), language: str = Form("")):
    """Server-side speech-to-text. Browser webkitSpeechRecognition fails on most Linux
    Chromium builds ('network' error); the frontend records with MediaRecorder and posts
    the blob here. Uses Groq's free Whisper endpoint (OpenAI-compatible)."""
    if not config.GROQ_ENABLED:
        return JSONResponse({"error": "no STT provider (GROQ_API_KEY missing)"}, status_code=503)
    raw = await file.read()
    if not raw:
        raise HTTPException(422, "empty audio")
    # Same model + domain-biasing prompt as the live agent (agent/worker.py STT_PROMPT):
    # Whisper continues the style of the prompt, so a sample site transcript pushes decoding
    # toward grid refs, drawing numbers and revisions the parser depends on.
    data = {"model": os.getenv("GROQ_STT_MODEL", "whisper-large-v3"),
            "response_format": "json", "temperature": "0",
            "prompt": ("Column line C-5, rebar spacing 180 millimetres, drawing A-102 revision R4. "
                       "Cover at B-4 column is 40 millimetres per IS 456. Stirrup spacing at C-6 "
                       "measured 220. Zone B Level 3 hot work permit HWP-0112, fire watch pending, "
                       "stop work. L4 slab thickness 150 millimetres on S-301 revision R2, RFI-050 "
                       "still open. Raise an NCR. Log the observation.")}
    if language:
        data["language"] = language
    try:
        async with httpx.AsyncClient(timeout=30.0) as cx:
            r = await cx.post(
                f"{config.GROQ_BASE_URL}/audio/transcriptions",
                headers={"Authorization": f"Bearer {config.GROQ_API_KEY}"},
                data=data,
                files={"file": (file.filename or "turn.webm", raw,
                                file.content_type or "audio/webm")})
        if r.status_code != 200:
            return _stt_error_response(r.status_code, r.text)
        try:
            return {"text": (r.json().get("text") or "").strip()}
        except (ValueError, AttributeError):
            return JSONResponse({"error": "invalid STT provider response"}, status_code=502)
    except httpx.TimeoutException:
        return JSONResponse({"error": "STT provider timed out"}, status_code=504)
    except httpx.HTTPError:
        return JSONResponse({"error": "STT provider is unavailable"}, status_code=503)


# ---------------------------------------------------------------- speaker enrollment
@app.get("/api/voice/status")
async def voice_status() -> dict:
    if not config.SPEAKER_ID_ENABLED:
        return {"enabled": False, "enrolled": False, "reachable": False}
    try:
        async with httpx.AsyncClient(timeout=2.0) as cx:
            r = await cx.get(f"{config.SPEAKER_ID_URL}/health")
        j = r.json() if r.status_code == 200 else {}
        return {"enabled": True, "reachable": r.status_code == 200,
                "enrolled": bool(j.get("enrolled")), "threshold": j.get("threshold")}
    except Exception as e:
        return {"enabled": True, "reachable": False, "enrolled": False, "error": str(e)}


@app.post("/api/voice/enroll")
async def voice_enroll(request: Request):
    """Forward N live audio clips to the voiceid sidecar to (re)enroll the site manager."""
    if not config.SPEAKER_ID_ENABLED:
        raise HTTPException(409, "speaker id disabled")
    form = await request.form()
    files = form.getlist("files") or ([form["file"]] if "file" in form else [])
    if not files:
        raise HTTPException(422, "no audio clips")
    payload = []
    for f in files:
        raw = await f.read()
        payload.append(("files", (getattr(f, "filename", "clip.webm"), raw,
                                  getattr(f, "content_type", None) or "application/octet-stream")))
    try:
        async with httpx.AsyncClient(timeout=30.0) as cx:
            r = await cx.post(f"{config.SPEAKER_ID_URL}/enroll", files=payload)
        return JSONResponse(r.json(), status_code=r.status_code)
    except Exception as e:
        raise HTTPException(502, f"voiceid enroll failed: {e}")


# ---------------------------------------------------------------- session
@app.post("/api/session")
async def new_session(request: Request) -> dict:
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    user = _user_id(request)
    sid = dbmod.create_session(_repo, user)
    _sessions[sid] = DialogueSession(_repo, sid, _llm)
    return {"sessionId": sid, "commandLimit": config.FREE_COMMAND_LIMIT if config.ENFORCE_FREE_COMMAND_LIMIT else None,
            "commandsUsed": dbmod.command_usage(_repo, user) if config.ENFORCE_FREE_COMMAND_LIMIT else 0}


@app.post("/api/bootstrap-demo")
async def bootstrap_demo(request: Request) -> dict:
    """Give the named demo account a small, clearly-labelled conversation archive once."""
    user = _user_id(request)
    body = await request.json()
    if str(body.get("email", "")).strip().lower() != config.DEMO_SEED_EMAIL:
        return {"seeded": False}
    if dbmod.sessions_for_user(_repo, user, limit=1):
        return {"seeded": False}
    sid = dbmod.create_session(_repo, user)
    dbmod.insert_turn(_repo, {"sessionId": sid, "role": "user", "text": "What should I check before today’s L4 slab pour?", "state": "capturing"})
    dbmod.insert_turn(_repo, {"sessionId": sid, "role": "agent", "text": "Start with the L4 pre-pour hold point and RFI-050. Confirm the latest S-301 revision and the cover requirement before logging.", "state": "challenging"})
    return {"seeded": True}


# ---------------------------------------------------------------- turn
async def _verify_speaker(audio: UploadFile | None) -> dict | None:
    if not audio or not config.SPEAKER_ID_ENABLED:
        return None
    try:
        raw = await audio.read()
        async with httpx.AsyncClient(timeout=8.0) as cx:
            r = await cx.post(f"{config.SPEAKER_ID_URL}/verify",
                              files={"file": (audio.filename or "turn.webm", raw,
                                              audio.content_type or "application/octet-stream")})
        if r.status_code == 200:
            return r.json()
        return {"match": False, "score": 0.0, "error": f"voiceid {r.status_code}"}
    except Exception as e:
        return {"match": False, "score": 0.0, "error": str(e)}


@app.post("/api/turn")
async def turn(
    request: Request,
    sessionId: str = Form(None),
    text: str = Form(""),
    bargeIn: str = Form(""),
    noise: str = Form("none"),
    decision: str = Form(None),
    language: str = Form("en-IN"),
    audio: UploadFile | None = None,
) -> dict:
    # accept JSON too (typed fallback path)
    if sessionId is None:
        try:
            body = await request.json()
            sessionId = body["sessionId"]
            text = body.get("text", "")
            bargeIn = body.get("bargeIn", False)
            noise = body.get("noise", "none")
            decision = body.get("decision")
            language = body.get("language", "en-IN")
        except Exception:
            raise HTTPException(422, "sessionId required")

    _reserve_or_limit(request)
    sess = _session(sessionId)
    speaker = await _verify_speaker(audio)
    barge = str(bargeIn).lower() in ("1", "true", "yes", "on")

    out: dict = sess.handle(text=text or "", barge_in=barge, noise=noise or "none",
                            decision=decision, speaker=speaker, language=language)
    out = dict(out)
    out["speaker"] = speaker

    # speaker gate
    if speaker is not None and config.SPEAKER_ID_ENABLED and not speaker.get("match"):
        out["allowedDecisions"] = []
        out.setdefault("blockers", []).append({
            "kind": "speaker_gate", "severity": "blocker",
            "detail": "Speaker not recognised as the enrolled site manager; logging is locked.",
            "evidence": {"score": speaker.get("score")},
        })
    return out


# ---------------------------------------------------------------- decision
@app.post("/api/decision")
async def decide(request: Request) -> dict:
    body = await request.json()
    sess = _session(body["sessionId"])
    dec = body["decision"]

    # re-verify gate: block logging decisions when the last turn failed speaker check
    last_speaker = getattr(sess, "last_speaker", None)
    if (config.SPEAKER_ID_ENABLED and last_speaker is not None and not last_speaker.get("match")
            and dec in ("log_observation", "raise_rfi", "raise_ncr")):
        raise HTTPException(403, "speaker not verified; logging locked")

    out = dict(sess.handle(text="", decision=dec))
    return out


@app.get("/api/conversations")
async def conversations(request: Request) -> dict:
    user = _user_id(request)
    sessions = dbmod.sessions_for_user(_repo, user)
    for session in sessions:
        session["turns"] = dbmod.turns_for_session(_repo, session["session_id"])
    return {"sessions": sessions, "commandLimit": config.FREE_COMMAND_LIMIT if config.ENFORCE_FREE_COMMAND_LIMIT else None,
            "commandsUsed": dbmod.command_usage(_repo, user) if config.ENFORCE_FREE_COMMAND_LIMIT else 0}


# ---------------------------------------------------------------- observations
@app.get("/api/observations")
def observations() -> list[dict]:
    rows = _repo._all(
        "SELECT observation_id, created_at, location_id, element, attribute, value_claimed, unit, "
        "drawing_id, revision_claimed, contradiction_flag, contradiction_kinds, final_decision, linked_rfi_id "
        "FROM field_observations WHERE project_id = ? ORDER BY created_at DESC", (config.PROJECT_ID,))
    for r in rows:
        r["contradiction_kinds"] = json.loads(r["contradiction_kinds"]) if r.get("contradiction_kinds") else []
    return rows


@app.get("/api/observations/{obs_id}")
def observation(obs_id: str) -> dict:
    row = _repo._one("SELECT * FROM field_observations WHERE observation_id = ?", (obs_id,))
    if not row:
        raise HTTPException(404, "not found")
    row["contradiction_kinds"] = json.loads(row["contradiction_kinds"]) if row.get("contradiction_kinds") else []
    evidence: dict[str, Any] = {}
    if row.get("drawing_id"):
        evidence["drawing"] = _repo.drawing_by_id(row["drawing_id"])
    if row.get("linked_rfi_id"):
        evidence["rfi"] = _repo._one("SELECT * FROM rfis WHERE rfi_id = ?", (row["linked_rfi_id"],))
    row["evidence"] = evidence
    return row


# ---------------------------------------------------------------- scenarios
@app.get("/api/scenarios")
def scenarios() -> list[dict]:
    try:
        from scenarios import load_scenarios
        return [{"id": s["id"], "title": s["title"]} for s in load_scenarios()]
    except Exception:
        return []


@app.post("/api/scenarios/run")
async def scenarios_run(request: Request) -> dict:
    try:
        body = await request.json()
    except Exception:
        body = {}
    try:
        from scenarios import run_all
        return run_all(body.get("ids"))
    except Exception as e:
        raise HTTPException(501, f"scenario runner not ready: {e}")


# ---------------------------------------------------------------- Rime TTS proxy
_tts_cache: dict[str, bytes] = {}


@app.post("/api/tts")
async def tts(request: Request):
    body = await request.json()
    text = (body.get("text") or "").strip()
    language = str(body.get("language") or "en-IN").strip().lower()
    if not text:
        raise HTTPException(422, "text required")
    if not config.RIME_ENABLED:
        return JSONResponse({"error": "rime key missing"}, status_code=503)
    use_hinglish = language.startswith("hi")
    speaker = config.RIME_SPEAKER if use_hinglish else config.RIME_SPEAKER_EN
    rime_lang = config.RIME_LANG if use_hinglish else config.RIME_LANG_EN
    model = config.RIME_MODEL if use_hinglish else config.RIME_MODEL_EN
    cache_key = f"{model}:{speaker}:{rime_lang}:{text}"
    if cache_key in _tts_cache:
        return StreamingResponse(io.BytesIO(_tts_cache[cache_key]), media_type="audio/mpeg")
    try:
        async with httpx.AsyncClient(timeout=20.0) as cx:
            r = await cx.post(
                "https://users.rime.ai/v1/rime-tts",
                headers={"Authorization": f"Bearer {config.RIME_API_KEY}",
                         "Accept": "audio/mp3", "Content-Type": "application/json"},
                json={"text": text, "speaker": speaker,
                      "modelId": model, "lang": rime_lang})
        if r.status_code != 200:
            return JSONResponse({"error": f"rime {r.status_code}", "detail": r.text[:300]},
                                status_code=502)
        audio = r.content
        if len(_tts_cache) < 64:
            _tts_cache[cache_key] = audio
        return StreamingResponse(io.BytesIO(audio), media_type="audio/mpeg")
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=502)


# ---------------------------------------------------------------- Memory (thin)
@app.get("/api/drawings")
def drawings() -> list[dict]:
    return _repo._all("SELECT * FROM drawings WHERE project_id = ? ORDER BY drawing_number, rev_ordinal",
                      (config.PROJECT_ID,))


@app.get("/api/rfis")
def rfis() -> list[dict]:
    return _repo._all("SELECT * FROM rfis WHERE project_id = ? ORDER BY rfi_id", (config.PROJECT_ID,))


@app.get("/api/permits")
def permits() -> list[dict]:
    return _repo.permits_with_checks()
