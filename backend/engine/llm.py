"""Optional LLM slot-filler. Cerebras -> NVIDIA NIM -> Groq (all OpenAI-compatible).

Faithful port of app/lib/engine/llm.ts, retargeted at OpenAI-compatible endpoints.

Only runs for slots the deterministic parser missed. Everything it returns is marked
``source="llm"`` with low confidence, so the dialogue engine forces a voice confirmation
before any of it can reach ``field_observations``.
"""
from __future__ import annotations

import json

import config

LLM_CONFIDENCE = 0.5
_TIMEOUT = 2.5

_MISSING_KEYS = ["grid", "level", "zone", "element", "attribute", "value", "unit",
                 "drawingNumber", "revisionClaimed", "activity"]

_SYSTEM = (
    "You extract construction-site entities from a noisy Hinglish (Hindi-English) speech "
    "transcript. Only fill a field if the transcript clearly implies it; otherwise omit it. "
    "Never guess numbers."
)

_TOOL = {
    "type": "function",
    "function": {
        "name": "fill_slots",
        "description": "Return the entities found in the transcript.",
        "parameters": {
            "type": "object",
            "properties": {
                "grid": {"type": "string", "description": "Grid line like C-5"},
                "level": {"type": "string", "description": "Level like L3"},
                "zone": {"type": "string", "description": "Zone like 'Zone B'"},
                "element": {"type": "string", "enum": ["column", "beam", "slab", "footing", "wall"]},
                "attribute": {"type": "string", "enum": ["rebar_spacing", "stirrup_spacing", "cover",
                                                        "thickness", "rebar_dia", "size", "grade",
                                                        "bar_count"]},
                "value": {"type": "number"},
                "unit": {"type": "string", "enum": ["mm", "cm", "m", "MPa", "nos"]},
                "drawingNumber": {"type": "string", "description": "Drawing number like A-102"},
                "revisionClaimed": {"type": "string", "description": "Revision like R3"},
                "activity": {"type": "string", "enum": ["hot_work", "pour", "height", "excavation"]},
            },
            "additionalProperties": False,
        },
    },
}


def make_llm_assist():
    """Return a callable ``(text, ex) -> dict`` of slot -> Slot suggestions, or None."""
    try:
        from openai import OpenAI
    except Exception:
        return None

    providers = []
    if getattr(config, "CEREBRAS_ENABLED", False):
        try:
            providers.append((
                OpenAI(base_url=config.CEREBRAS_BASE_URL, api_key=config.CEREBRAS_API_KEY,
                       timeout=_TIMEOUT, max_retries=0),
                config.CEREBRAS_LLM_MODEL,
            ))
        except Exception:
            pass
    if getattr(config, "NVIDIA_ENABLED", False):
        try:
            providers.append((
                OpenAI(base_url=config.NVIDIA_BASE_URL, api_key=config.NVIDIA_API_KEY,
                       timeout=_TIMEOUT, max_retries=0),
                config.NVIDIA_LLM_MODEL,
            ))
        except Exception:
            pass
    if getattr(config, "GROQ_ENABLED", False):
        try:
            providers.append((
                OpenAI(base_url=config.GROQ_BASE_URL, api_key=config.GROQ_API_KEY,
                       timeout=_TIMEOUT, max_retries=0),
                config.GROQ_LLM_MODEL,
            ))
        except Exception:
            pass
    if not providers:
        return None

    def assist(text: str, ex) -> dict:
        missing = [k for k in _MISSING_KEYS if not getattr(ex, k, None)]
        if not missing:
            return {}
        user = f"Transcript: {text}\nFields still missing: {', '.join(missing)}"
        for client, model in providers:
            try:
                res = client.chat.completions.create(
                    model=model,
                    max_tokens=400,
                    temperature=0,
                    messages=[{"role": "system", "content": _SYSTEM},
                              {"role": "user", "content": user}],
                    tools=[_TOOL],
                    tool_choice={"type": "function", "function": {"name": "fill_slots"}},
                    timeout=_TIMEOUT,
                )
                calls = res.choices[0].message.tool_calls or []
                if not calls:
                    return {}
                data = json.loads(calls[0].function.arguments or "{}")
                out: dict = {}
                for k in missing:
                    v = data.get(k)
                    if v is None or v == "":
                        continue
                    out[k] = {"value": v, "confidence": LLM_CONFIDENCE, "source": "llm"}
                return out
            except Exception:
                continue
        return {}  # degraded mode: parser-only

    return assist
