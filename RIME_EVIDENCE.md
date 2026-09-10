# Rime evidence

## Hard voice claim

Vesper can synthesize a short Hinglish/Hindi-capable spoken safety response through a server-side Rime proxy. The browser never receives the Rime API key.

## Locked organizer configuration

| Setting | Value |
| --- | --- |
| Model ID | `arcana` |
| Speaker | `astra` |
| Language | `hin` |
| Endpoint | `https://users.rime.ai/v1/rime-tts` |
| Upstream transport | HTTPS `POST`, JSON request body, Bearer authentication |
| Requested / returned audio format | `audio/mp3` / `audio/mpeg` |
| App route | `POST /api/tts` |
| App-to-browser transport | HTTP response consumed by a single HTML `<audio>` element |

The backend keeps a small in-memory response cache (up to 64 prompts). It currently reads the upstream response before returning it, so this implementation is a buffered HTTP proxy, not chunk-by-chunk audio streaming.

## Acceptance test

**Pass condition:** a preflight request returns an audio content type and non-zero audio bytes, without exposing a secret.

## Repeatable procedure

1. Copy `.env.example` to an ignored local env file and supply the organizer-issued Rime secret.
2. Run the configuration-only check:

   ```bash
   python3 scripts/rime_preflight.py --env-file backend/.env.local
   ```

3. Run the network/audio check:

   ```bash
   python3 scripts/rime_preflight.py --env-file backend/.env.local --request
   ```

4. For the application path, start the backend and issue a short request:

   ```bash
   curl -sS -o /dev/null -w '%{http_code} %{content_type} %{size_download}\n' \
     -X POST http://127.0.0.1:8000/api/tts \
     -H 'Content-Type: application/json' \
     --data '{"text":"Vesper voice check."}'
   ```

## Result

On 2026-09-10, the application-path smoke test returned `200`, `audio/mpeg`, and 28,800 audio bytes. The LiveKit token endpoint also returned `200` with the configured cloud transport.

## Limitations

- This confirms TTS generation and proxying, not perceptual quality, Hindi pronunciation quality, or live barge-in latency on a physical phone.
- Network outages, invalid/revoked credentials, quota limits, and unsupported upstream settings return a clear non-2xx error; the UI falls back to the browser speech synthesizer when the proxy is unavailable.
- The current implementation is buffered rather than upstream-streaming, so playback does not begin until the upstream TTS response is complete.
