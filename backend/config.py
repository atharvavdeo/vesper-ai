"""Loads the repo-root .env and exposes settings. Server-side only; never logged."""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parent
REPO_ROOT = BACKEND_DIR.parent

load_dotenv(REPO_ROOT / ".env")
load_dotenv(BACKEND_DIR / ".env.local", override=True)  # optional local override


def _bool(v: str | None, default: bool = False) -> bool:
    if v is None:
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


_raw_db = os.getenv("SITE_DB_PATH", "../data/site.db")
SITE_DB_PATH = _raw_db if os.path.isabs(_raw_db) else str((BACKEND_DIR / _raw_db).resolve())

PROJECT_ID = os.getenv("PROJECT_ID", "P1")
CRITICAL_FIELDS = [s.strip() for s in os.getenv(
    "CRITICAL_FIELDS", "location,drawing_number,dimension_claimed").split(",") if s.strip()]

# ---- Rime TTS ----
RIME_API_KEY = os.getenv("RIME_API_KEY", "").strip()
RIME_MODEL = os.getenv("RIME_MODEL", "arcana")
RIME_SPEAKER = os.getenv("RIME_SPEAKER", "").strip()
RIME_LANG = os.getenv("RIME_LANG", "hi")
RIME_ENABLED = bool(RIME_API_KEY) and not RIME_API_KEY.startswith("<")

# ---- LLM ----
NVIDIA_API_KEY = os.getenv("NVIDIA_API_KEY", "").strip()
NVIDIA_BASE_URL = os.getenv("NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1")
NVIDIA_LLM_MODEL = os.getenv("NVIDIA_LLM_MODEL", "meta/llama-3.3-70b-instruct")
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "").strip()
GROQ_BASE_URL = os.getenv("GROQ_BASE_URL", "https://api.groq.com/openai/v1")
GROQ_LLM_MODEL = os.getenv("GROQ_LLM_MODEL", "llama-3.3-70b-versatile")


def _key_ok(k: str) -> bool:
    return bool(k) and not k.startswith("<")


NVIDIA_ENABLED = _key_ok(NVIDIA_API_KEY)
GROQ_ENABLED = _key_ok(GROQ_API_KEY)


def llm_provider() -> str:
    if NVIDIA_ENABLED:
        return "nvidia"
    if GROQ_ENABLED:
        return "groq"
    return "off"


# ---- Speaker ID ----
SPEAKER_ID_ENABLED = _bool(os.getenv("SPEAKER_ID_ENABLED"), False)
SPEAKER_ID_URL = os.getenv("SPEAKER_ID_URL", "http://localhost:8788").rstrip("/")
SPEAKER_ID_THRESHOLD = float(os.getenv("SPEAKER_ID_THRESHOLD", "0.70"))
