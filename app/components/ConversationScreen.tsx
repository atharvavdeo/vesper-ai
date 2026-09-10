"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BarVisualizer,
  LiveKitRoom,
  RoomAudioRenderer,
  StartAudio,
  useDataChannel,
  useLocalParticipant,
  useVoiceAssistant,
  useTrackTranscription,
} from "@livekit/components-react";
import type { TrackReferenceOrPlaceholder } from "@livekit/components-react";
import { Track } from "livekit-client";
import "@livekit/components-styles";
import { api, ApiError, type RtcToken } from "@/lib/api";
import { Card, Chip, ErrorBanner } from "@/components/ui";

// ---- engine data-message shape (topic "vesper") ----
type EngineContradiction = { kind?: string; detail: string; evidence?: unknown };
type EngineBlocker = { kind?: string; detail: string };
type EngineMissing = { detail: string };
type EngineFact = {
  value?: unknown;
  unit?: string;
  tolerance?: unknown;
  revision?: string;
  issued_on?: string;
  via_rfi?: unknown;
  code_ref?: string;
};
type EngineResolved = {
  location_id?: string;
  drawing?: string;
  drawing_id?: string;
  fact?: EngineFact;
};
type EngineResult = {
  state?: string;
  contradictions?: EngineContradiction[];
  blockers?: EngineBlocker[];
  missing?: EngineMissing[];
  resolved?: EngineResolved;
  slots?: Record<string, unknown>;
  allowed_decisions?: string[];
  grounding_line?: string;
  logged?: unknown;
};

const DECISION_HINTS: Record<string, string> = {
  log_observation: '"log kar do"',
  raise_rfi: '"RFI raise karo"',
  raise_ncr: '"NCR"',
  stop_work: '"stop work"',
  cancel: '"cancel"',
};

function slotText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("value" in o) return slotText(o.value);
    return JSON.stringify(o);
  }
  return String(v);
}

export default function ConversationScreen() {
  const [creds, setCreds] = useState<RtcToken | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [is503, setIs503] = useState(false);

  const start = useCallback(async () => {
    setConnecting(true);
    setError(null);
    setIs503(false);
    try {
      const t = await api.rtcToken({ name: "Manager" });
      setCreds(t);
    } catch (e) {
      const err = e as Error;
      if (e instanceof ApiError && e.status === 503) setIs503(true);
      setError(err.message);
    } finally {
      setConnecting(false);
    }
  }, []);

  const end = useCallback(() => {
    setCreds(null);
  }, []);

  if (!creds) {
    return (
      <div className="flex flex-col gap-4 p-4 pb-28">
        <header className="flex items-center justify-between">
          <h1 className="text-lg font-semibold">Talk</h1>
        </header>

        <p className="text-sm text-zinc-400">
          Full-duplex voice with Vesper. Talk naturally — decisions are made by
          voice.
        </p>

        <button
          onClick={start}
          disabled={connecting}
          className="mx-auto mt-6 flex h-44 w-44 select-none items-center justify-center rounded-full border-4 border-emerald-500 bg-emerald-600 text-center text-lg font-semibold text-white transition disabled:opacity-40"
        >
          {connecting ? "Connecting…" : "Start conversation"}
        </button>

        {error ? (
          <div className="mt-4">
            <ErrorBanner msg={error} />
            {is503 ? (
              <p className="mt-2 text-center text-xs text-amber-400">
                LiveKit is not configured — set LIVEKIT_* in .env
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <LiveKitRoom
      serverUrl={creds.url}
      token={creds.token}
      connect
      audio
      video={false}
      onDisconnected={end}
      className="flex flex-col gap-4 p-4 pb-28"
    >
      <RoomView room={creds.room} onEnd={end} />
    </LiveKitRoom>
  );
}

function RoomView({ room, onEnd }: { room: string; onEnd: () => void }) {
  const { state, audioTrack, agentTranscriptions } = useVoiceAssistant();
  const { microphoneTrack, localParticipant } = useLocalParticipant();
  const [engine, setEngine] = useState<EngineResult | null>(null);

  const micTrackRef = useMemo<TrackReferenceOrPlaceholder | undefined>(() => {
    if (!localParticipant) return undefined;
    return {
      participant: localParticipant,
      source: Track.Source.Microphone,
      publication: microphoneTrack,
    };
  }, [localParticipant, microphoneTrack]);

  const { segments: userSegments } = useTrackTranscription(micTrackRef);

  useDataChannel("vesper", (msg) => {
    try {
      const d = JSON.parse(new TextDecoder().decode(msg.payload)) as {
        type?: string;
        result?: EngineResult;
      };
      if (d.type === "engine" && d.result) setEngine(d.result);
    } catch {
      /* ignore malformed */
    }
  });

  // merged, time-ordered transcript
  const transcript = useMemo(() => {
    const rows: { who: "You" | "Vesper"; text: string; ts: number; id: string }[] =
      [];
    for (const s of userSegments)
      rows.push({
        who: "You",
        text: s.text,
        ts: s.firstReceivedTime ?? 0,
        id: `u-${s.id}`,
      });
    for (const s of agentTranscriptions)
      rows.push({
        who: "Vesper",
        text: s.text,
        ts: s.firstReceivedTime ?? 0,
        id: `a-${s.id}`,
      });
    return rows.sort((a, b) => a.ts - b.ts);
  }, [userSegments, agentTranscriptions]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [transcript]);

  const contradictions = engine?.contradictions ?? [];
  const blockers = engine?.blockers ?? [];
  const missing = engine?.missing ?? [];
  const slots = engine?.slots ?? {};
  const resolved = engine?.resolved;
  const fact = resolved?.fact;
  const allowed = engine?.allowed_decisions ?? [];
  const logged = engine?.logged;
  const loggedId =
    logged && typeof logged === "object"
      ? ((logged as Record<string, unknown>).observation_id as string) ??
        JSON.stringify(logged)
      : typeof logged === "string"
        ? logged
        : null;

  return (
    <>
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Talk</h1>
        <div className="flex items-center gap-2 text-xs text-zinc-400">
          <span>{room}</span>
          <button
            onClick={onEnd}
            className="rounded border border-red-500 px-2 py-1 text-red-300"
          >
            End
          </button>
        </div>
      </header>

      <RoomAudioRenderer />
      <StartAudio
        label="Tap to enable audio"
        className="rounded-lg border border-zinc-600 px-3 py-2 text-sm"
      />

      {/* agent state + visualizer */}
      <div className="flex items-center gap-3">
        <span className="rounded-full border border-zinc-600 px-3 py-1 text-xs uppercase tracking-wide text-zinc-300">
          {state ?? "connecting"}
        </span>
        <div className="h-12 flex-1">
          <BarVisualizer
            state={state}
            trackRef={audioTrack}
            barCount={7}
            className="h-full w-full"
          />
        </div>
      </div>

      {/* live transcript */}
      <Card title="Transcript">
        <div
          ref={scrollRef}
          className="flex max-h-56 flex-col gap-1 overflow-y-auto"
        >
          {transcript.length === 0 ? (
            <p className="text-zinc-500">Say something to begin…</p>
          ) : (
            transcript.map((r) => (
              <p key={r.id}>
                <span
                  className={
                    r.who === "You" ? "text-zinc-400" : "text-emerald-400"
                  }
                >
                  {r.who}:
                </span>{" "}
                {r.text}
              </p>
            ))
          )}
        </div>
      </Card>

      {/* contradictions */}
      {contradictions.length ? (
        <Card tone="red" title="Contradictions">
          <ul className="list-disc pl-5">
            {contradictions.map((c, i) => (
              <li key={i}>{c.detail}</li>
            ))}
          </ul>
        </Card>
      ) : null}

      {/* blockers */}
      {blockers.length ? (
        <Card tone="amber" title="Blockers">
          <ul className="list-disc pl-5">
            {blockers.map((b, i) => (
              <li key={i}>{b.detail}</li>
            ))}
          </ul>
        </Card>
      ) : null}

      {/* slots */}
      {Object.keys(slots).length ? (
        <div className="flex flex-wrap gap-2">
          {Object.entries(slots).map(([k, v]) => {
            const t = slotText(v);
            return t ? <Chip key={k} label={`${k}: ${t}`} /> : null;
          })}
        </div>
      ) : null}

      {/* resolved facts */}
      {resolved && (resolved.drawing || resolved.location_id || fact) ? (
        <Card title="Facts">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            {resolved.location_id ? (
              <>
                <dt className="text-zinc-500">location</dt>
                <dd>{resolved.location_id}</dd>
              </>
            ) : null}
            {resolved.drawing || resolved.drawing_id ? (
              <>
                <dt className="text-zinc-500">drawing</dt>
                <dd>
                  {resolved.drawing ?? ""}
                  {resolved.drawing_id ? ` (${resolved.drawing_id})` : ""}
                </dd>
              </>
            ) : null}
            {fact?.revision ? (
              <>
                <dt className="text-zinc-500">revision</dt>
                <dd>{fact.revision}</dd>
              </>
            ) : null}
            {fact?.issued_on ? (
              <>
                <dt className="text-zinc-500">issued</dt>
                <dd>{fact.issued_on}</dd>
              </>
            ) : null}
            {fact?.via_rfi != null && fact.via_rfi !== false ? (
              <>
                <dt className="text-zinc-500">via RFI</dt>
                <dd>{String(fact.via_rfi)}</dd>
              </>
            ) : null}
            {fact?.value != null ? (
              <>
                <dt className="text-zinc-500">expected</dt>
                <dd>
                  {String(fact.value)}
                  {fact.unit ? ` ${fact.unit}` : ""}
                  {fact.tolerance != null ? ` ± ${String(fact.tolerance)}` : ""}
                </dd>
              </>
            ) : null}
            {fact?.code_ref ? (
              <>
                <dt className="text-zinc-500">code ref</dt>
                <dd>{fact.code_ref}</dd>
              </>
            ) : null}
          </dl>
        </Card>
      ) : null}

      {/* missing */}
      {missing.length ? (
        <Card tone="amber" title="Need">
          {missing.map((m) => m.detail).join(" · ")}
        </Card>
      ) : null}

      {/* logged */}
      {loggedId ? (
        <Card tone="green">Logged {loggedId}</Card>
      ) : null}

      {/* voice decision hints */}
      {allowed.length ? (
        <p className="text-xs text-zinc-500">
          Say:{" "}
          {allowed
            .map((d) => DECISION_HINTS[d] ?? `"${d}"`)
            .join(" · ")}
        </p>
      ) : null}
    </>
  );
}
