# Vesper architecture pipeline

Vesper is intentionally not a single chat completion. It is a set of separate,
bounded systems: the browser captures intent, Clerk supplies identity, LiveKit transports
live audio, deterministic rules decide safety-critical outcomes, and the language model only
phrases grounded responses. This document maps the production path and the degraded paths.

## 1. System and trust-boundary overview

```mermaid
flowchart LR
  classDef person fill:#f8fafc,stroke:#64748b,color:#0f172a
  classDef client fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e
  classDef edge fill:#f1f5f9,stroke:#475569,color:#0f172a
  classDef service fill:#ecfdf5,stroke:#059669,color:#064e3b
  classDef store fill:#fff7ed,stroke:#ea580c,color:#7c2d12
  classDef external fill:#faf5ff,stroke:#7e22ce,color:#581c87
  classDef guard fill:#fef2f2,stroke:#dc2626,color:#7f1d1d

  Manager["Site manager<br/>desktop or mobile browser"]:::person

  subgraph Public["Public browser trust boundary"]
    Landing["Next.js landing<br/>SEO + suggested questions"]:::client
    ClerkUI["Clerk sign-in / sign-up<br/>custom split-screen shell"]:::client
    Console["Authenticated Vesper console<br/>Talk · Live · Logs · Scenarios · Enroll"]:::client
    Tour["Driver.js first-login tour<br/>keyed by Clerk user ID"]:::client
    Recorder["MediaRecorder fallback<br/>audio/webm upload"]:::client
    LKClient["livekit-client<br/>WebRTC mic + data events"]:::client
    History["Conversation/history UI<br/>session-scoped turns"]:::client
  end

  subgraph Identity["Identity boundary"]
    Clerk["Clerk<br/>session JWT + user profile"]:::external
  end

  subgraph Render["Render private application boundary"]
    API["FastAPI API<br/>CORS · Clerk JWT verification · error mapping"]:::service
    Quota["Command reservation gate<br/>atomic 3-command limit per user"]:::guard
    Engine["Deterministic dialogue engine<br/>extract → normalize → contradiction rules"]:::service
    TTSProxy["Rime TTS proxy<br/>server-only secret"]:::service
    VoiceID["SpeechBrain ECAPA sidecar :8788<br/>enrol + cosine speaker verification"]:::guard
    Agent["LiveKit worker<br/>VAD · STT · tool-calling LLM · TTS"]:::service
    SQLite[("Persistent SQLite disk<br/>facts · sessions · turns · observations · quota")]:::store
  end

  subgraph Providers["External provider boundary"]
    LiveKit["LiveKit Cloud<br/>room routing + WebRTC SFU"]:::external
    Groq["Groq Whisper / fallback LLM"]:::external
    NIM["Cerebras gpt-oss-120b → NVIDIA NIM<br/>LLM fallback chain (unresolved questions only)"]:::external
    Rime["Rime Arcana<br/>mistv3 · cove · eng · WebSocket"]:::external
  end

  Manager --> Landing
  Landing --> ClerkUI
  ClerkUI <-->|"session management"| Clerk
  ClerkUI --> Console
  Console --> Tour
  Console --> History
  Console -->|"Bearer Clerk JWT"| API
  API <-->|"JWKS / issuer validation"| Clerk
  API --> Quota --> SQLite
  API --> Engine --> SQLite
  Console --> Recorder -->|"POST /api/stt (audio/webm)"| API
  API -->|"Whisper transcription"| Groq
  Console -->|"POST /api/rtc/token"| API
  API -->|"signed room token"| LKClient
  LKClient <-->|"WebRTC audio + data"| LiveKit
  LiveKit <-->|"dispatched job"| Agent
  Agent -->|"streaming STT"| Groq
  Agent -->|"grounded typed tools"| Engine
  Agent <-->|"speaker samples / decision gate"| VoiceID
  Agent -->|"primary / fallback phrasing only"| NIM
  Agent -. "fallback" .-> Groq
  Agent -->|"streaming synthesis"| Rime
  TTSProxy -->|"HTTP TTS fallback"| Rime
```

## 2. Live voice: the critical request-to-record pipeline

```mermaid
sequenceDiagram
  autonumber
  actor M as Site manager
  participant B as Next.js browser
  participant C as Clerk
  participant A as FastAPI
  participant Q as Quota gate
  participant L as LiveKit Cloud
  participant W as LiveKit worker
  participant V as VoiceID sidecar
  participant S as Groq Whisper
  participant E as Deterministic engine
  participant D as SQLite
  participant X as LLM (Cerebras → NIM → Groq)
  participant R as Rime

  M->>B: Sign in / sign up
  B->>C: Authenticate
  C-->>B: Session JWT + Clerk user ID
  B->>A: POST /api/bootstrap-demo (only named demo email)
  A->>D: Seed first-run demo session + two safe sample turns once
  B->>A: POST /api/sessions with Bearer JWT
  A->>C: Verify JWT against issuer JWKS
  A->>D: Create / resume user-scoped session
  B->>A: POST /api/rtc/token
  A->>Q: Atomically reserve one of 3 free commands
  Q->>D: Persist used-command count
  alt quota available
    A-->>B: Signed LiveKit room token + room identity
    B->>L: Join room over WebRTC; publish microphone
    L->>W: Dispatch worker job for room
    W->>D: Read site brief, latest facts, RFIs, permits and hold points
    W-->>B: Publish greeting + structured site brief on data topic
    M->>B: Speak a site observation
    B->>L: Stream microphone frames
    L->>W: Audio stream + barge-in events
    W->>S: Streaming STT with construction vocabulary prompt
    S-->>W: Transcript
    W->>V: Verify enrolled speaker (rolling 4 s) and re-verify the command's own utterance before any write
    V-->>W: Similarity score / verified state
    W->>E: Brain.observe(verbatim transcript) — every finished turn, no LLM hop
    E->>D: Resolve current facts and rule views
    E-->>W: entities, blockers, contradictions, allowed decisions
    W-->>B: Publish structured result for evidence cards
    Note over W,R: every reply passes engine.speech.speakable() (short sentences, no typographic dashes, capped length) before Rime
    alt question
      W->>R: Speak engine answer (latest facts, open items) — LLM + recall only if unresolved
    else clean and verified
      W->>R: Stream engine read-back (mistv3/cove/eng over WebSocket)
      R-->>B: Spoken confirmation
      M->>B: Explicitly choose Log
      B->>L: Decision turn
      W->>E: log_observation
      E->>D: Persist linked observation + turn
    else contradiction, permit or hold-point blocker
      W->>R: Stream engine challenge with evidence and allowed choices
      R-->>B: Evidence-backed spoken correction
      M->>B: Choose RFI / NCR / Stop / Cancel / Log if allowed
      W->>E: Execute typed decision
      E->>D: Persist decision, linked IDs and history
    else speaker not verified or fields missing
      W-->>B: Ask for clarification; no write tool is enabled
    end
  else 3 commands already consumed
    A-->>B: 429 free_command_limit_reached
    B-->>M: Animated thank-you / upgrade boundary; no room token
  end
```

## 3. Browser typed-chat fallback and provider failure behaviour

```mermaid
flowchart TD
  Start["User submits voice or typed observation"] --> Choice{"Transport available?"}
  Choice -->|"LiveKit connected"| Live["LiveKit worker conversation path"]
  Choice -->|"LiveKit unavailable / reconnecting"| Typed["Typed chat fallback<br/>POST /api/turn"]
  Choice -->|"Browser voice fallback"| Record["MediaRecorder creates finalized WebM"]

  Record --> Valid{"Non-empty supported audio?"}
  Valid -->|No| Audio422["422 invalid or unsupported audio<br/>Prompt user to record again"]
  Valid -->|Yes| STT["POST /api/stt → Groq Whisper"]
  STT --> STTOutcome{"Provider response"}
  STTOutcome -->|200| Typed
  STTOutcome -->|400 / 413 / 415 / 422| Audio422
  STTOutcome -->|401 / 403| STT503["503 STT provider not configured<br/>Do not expose provider diagnostics"]
  STTOutcome -->|429| Busy503["503 provider temporarily busy<br/>Keep typed fallback available"]
  STTOutcome -->|timeout| Timeout504["504 provider timed out<br/>Retain draft; retry explicitly"]
  STTOutcome -->|other upstream error| Upstream502["502 transcription failed<br/>Show safe generic error"]

  Live --> Safety["Same deterministic engine + write gate"]
  Typed --> Safety
  Safety --> EngineOK{"Engine / database available?"}
  EngineOK -->|Yes| Verify{"Speaker verified and decision allowed?"}
  EngineOK -->|No| Degraded["No unsafe write<br/>Show offline state and retain local UI context"]
  Verify -->|No| Refuse["Clarify or refuse; do not persist an observation"]
  Verify -->|Yes| Persist["Persist linked observation, decision and conversation turn"]

  classDef failure fill:#fef2f2,stroke:#dc2626,color:#7f1d1d
  classDef safe fill:#ecfdf5,stroke:#059669,color:#064e3b
  class Audio422,STT503,Busy503,Timeout504,Upstream502,Degraded,Refuse failure
  class Persist safe
```

## 4. Data ownership and security invariants

| Boundary | What crosses it | Enforced invariant |
| --- | --- | --- |
| Browser → API | Clerk bearer token, typed input or recorder blob | Server validates a configured Clerk issuer before attributing work to a deployed user. |
| API → quota store | Authenticated user ID | A room token is never minted after the atomic three-command reservation fails. |
| Browser ↔ LiveKit | WebRTC media, room token, structured data messages | Browser gets a short-lived room token, never LiveKit API secret. |
| Worker → engine | Verbatim transcript and explicit decision | LLM calls typed engine tools; it does not decide a contradiction or make a write directly. |
| Worker → VoiceID | Live speaker frames | An unverified speaker cannot unlock write decisions. |
| Engine → SQLite | Resolved IDs and decisions | Observations are linked to project facts/drawings rather than recorded as ungrounded prose. |
| Server → Groq / NIM / Rime | Provider requests | API credentials stay server-side; the browser never receives them. |

## 5. Deployment topology

```mermaid
flowchart LR
  User["Manager browser"] --> Vercel["Vercel<br/>Next.js frontend"]
  Vercel -->|"HTTPS API calls + Clerk token"| API["Render Web Service<br/>FastAPI :8000"]
  API --> Disk[("Render persistent disk<br/>site.db")]
  API --> Voice["Render private service<br/>VoiceID :8788"]
  API --> LK["LiveKit Cloud"]
  LK --> Worker["Render background worker<br/>LiveKit agent"]
  Worker --> Disk
  API --> Providers["Groq / NVIDIA / Rime"]
  Worker --> Providers
  Vercel --> Clerk["Clerk hosted auth"]
```

The web service, agent worker and VoiceID sidecar intentionally deploy separately: a frontend
release cannot restart an active voice worker, and a LiveKit reconnect does not weaken the
HTTP chat fallback or the deterministic data store.
