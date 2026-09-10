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
import { Card, Chip, ErrorBanner, Button, VesperLogo, WaveVisualizer } from "@/components/ui";

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

// ---- site brief / memory data-message shape (topic "vesper") ----
type BriefProject = {
  name?: string;
  client?: string;
  location?: string;
  contract_type?: string;
  start_date?: string;
};
type BriefDailyLog = { log_date?: string; weather?: string; work_done?: string; safety?: string };
type BriefObservation = {
  observation_id?: string;
  on_date?: string;
  location_id?: string;
  element?: string;
  attribute?: string;
  value_claimed?: unknown;
  unit?: string;
  drawing_id?: string;
  final_decision?: string;
};
type BriefRfi = {
  rfi_id?: string;
  subject?: string;
  location_id?: string;
  drawing_ref?: string;
  status?: string;
  impact?: string;
};
type BriefPermit = {
  permit_id?: string;
  permit_type?: string;
  location_id?: string;
  status?: string;
  unsatisfied_mandatory_checks?: string[];
};
type BriefHoldPoint = {
  instance_id?: string;
  template_id?: string;
  location_id?: string;
  element?: string;
  planned_activity?: string;
  planned_for?: string;
  status?: string;
  notes?: string;
};
type BriefSubmittal = { submittal_id?: string; material?: string; status?: string; comments?: string };
type BriefDrawing = { drawing_number?: string; revision?: string; issued_on?: string; title?: string };

type SiteBrief = {
  project?: BriefProject;
  today_is?: string;
  recent_daily_logs?: BriefDailyLog[];
  recent_observations?: BriefObservation[];
  open_rfis?: BriefRfi[];
  active_permits?: BriefPermit[];
  open_hold_points?: BriefHoldPoint[];
  pending_submittals?: BriefSubmittal[];
  current_drawings?: BriefDrawing[];
};

function truncate(s: string | undefined, n: number): string {
  if (!s) return "";
  return s.length > n ? `${s.slice(0, n).trimEnd()}…` : s;
}

export default function ConversationScreen() {
  const [creds, setCreds] = useState<RtcToken | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [is503, setIs503] = useState(false);
  const [limitReached, setLimitReached] = useState(false);

  const start = useCallback(async () => {
    setConnecting(true);
    setError(null);
    setIs503(false);
    setLimitReached(false);
    try {
      const t = await api.rtcToken({ name: "Manager" });
      setCreds(t);
    } catch (e) {
      const err = e as Error;
      if (e instanceof ApiError && e.status === 503) setIs503(true);
      if (e instanceof ApiError && e.status === 429) setLimitReached(true);
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
      <div className="flex flex-col gap-4">
        <div className="glass-panel py-8 px-6 flex flex-col items-center justify-center text-center">
          <span className="text-[10px] font-mono uppercase tracking-widest text-zinc-400 mb-1">
            Realtime Voice Pipeline
          </span>
          <h2 className="text-xl font-medium text-white tracking-tight">
            Full-Duplex <span className="editorial-em">Conversational AI</span>
          </h2>
          <p className="mt-2 text-xs text-zinc-400 max-w-[280px] leading-relaxed">
            Talk naturally with sub-second latency. All drawings, BOQs, and decisions are resolved on the fly.
          </p>

          <div className="mt-8 mic-shell">
            <button
              onClick={start}
              disabled={connecting}
              className="mic-circle"
              aria-label="Start Conversation"
            >
              {connecting ? (
                <svg className="animate-spin h-7 w-7 text-zinc-900" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
              ) : (
                <svg className="w-8 h-8 text-black" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" x2="12" y1="19" y2="22" />
                </svg>
              )}
            </button>
          </div>

          <div className="mt-4">
            <Button
              variant="solid"
              size="md"
              onClick={start}
              disabled={connecting}
            >
              {connecting ? "Connecting pipeline…" : "Start Conversation"}
            </Button>
          </div>
        </div>

        {error ? (
          <div className="flex flex-col gap-2">
            <ErrorBanner msg={error} />
            {is503 ? (
              <p className="text-center text-xs text-amber-400 font-mono">
                LiveKit is not configured — check LIVEKIT_* in your .env file
              </p>
            ) : null}
            {limitReached ? (
              <p className="text-center text-xs text-sky-200 font-mono">
                Thank you — your three complimentary Vesper commands are complete. Review your conversation archive in Talk.
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
      className="flex flex-col gap-4"
    >
      <RoomView room={creds.room} onEnd={end} />
    </LiveKitRoom>
  );
}

function RoomView({ room, onEnd }: { room: string; onEnd: () => void }) {
  const { state, audioTrack, agentTranscriptions } = useVoiceAssistant();
  const { microphoneTrack, localParticipant } = useLocalParticipant();
  const [engine, setEngine] = useState<EngineResult | null>(null);
  const [brief, setBrief] = useState<SiteBrief | null>(null);

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
        brief?: SiteBrief;
      };
      if (d.type === "engine" && d.result) setEngine(d.result);
      if (d.type === "brief" && d.brief) setBrief(d.brief);
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
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-2">
          <span className="p-live-dot" />
          <span className="font-mono text-xs text-zinc-400">room: {room}</span>
        </div>
        <Button variant="ghost" size="sm" onClick={onEnd} className="text-red-300 border-red-500/40">
          Disconnect
        </Button>
      </div>

      <RoomAudioRenderer />
      <div className="glass-panel p-2">
        <StartAudio
          label="Tap to enable audio"
          className="w-full text-center text-xs py-1.5 text-zinc-300 hover:text-white"
        />
      </div>

      <SiteMemoryPanel brief={brief} />

      {/* Visualizer card */}
      <div className="glass-panel p-4 flex items-center gap-4">
        <span className="rounded-full border border-white/15 bg-white/5 px-2.5 py-1 text-[10px] uppercase tracking-wider font-mono text-zinc-300 shrink-0">
          {state ?? "idle"}
        </span>
        <div className="h-10 flex-1">
          <BarVisualizer
            state={state}
            trackRef={audioTrack}
            barCount={9}
            className="h-full w-full"
          />
        </div>
      </div>

      {/* Live transcript with bubbles */}
      <Card title="Live Stream Transcript">
        <div
          ref={scrollRef}
          className="flex max-h-60 flex-col gap-2.5 overflow-y-auto pr-1"
        >
          {transcript.length === 0 ? (
            <p className="text-xs text-zinc-500 py-3 text-center">
              Speak an observation naturally to begin streaming…
            </p>
          ) : (
            transcript.map((r) => (
              <div
                key={r.id}
                className={`flex flex-col ${
                  r.who === "You" ? "items-end self-end max-w-[88%]" : "items-start self-start max-w-[92%]"
                }`}
              >
                <span className="text-[9.5px] font-mono text-zinc-500 mb-0.5 px-1">
                  {r.who}
                </span>
                <div className={r.who === "You" ? "bubble-user" : "bubble-agent"}>
                  {r.text}
                </div>
              </div>
            ))
          )}
        </div>
      </Card>

      {/* Contradictions */}
      {contradictions.length ? (
        <Card tone="red" title="Contradictions">
          <ul className="space-y-1 text-xs text-red-100">
            {contradictions.map((c, i) => (
              <li key={i} className="flex items-start gap-1.5">
                <span className="text-red-400">•</span>
                <span>{c.detail}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {/* Blockers */}
      {blockers.length ? (
        <Card tone="amber" title="Blockers">
          <ul className="space-y-1 text-xs text-amber-100">
            {blockers.map((b, i) => (
              <li key={i} className="flex items-start gap-1.5">
                <span className="text-amber-400">•</span>
                <span>{b.detail}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {/* Context slots */}
      {Object.keys(slots).length ? (
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(slots).map(([k, v]) => {
            const t = slotText(v);
            return t ? <Chip key={k} label={`${k}: ${t}`} /> : null;
          })}
        </div>
      ) : null}

      {/* Resolved facts */}
      {resolved && (resolved.drawing || resolved.location_id || fact) ? (
        <Card title="Resolved Drawing Facts">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs font-mono">
            {resolved.location_id ? (
              <>
                <dt className="text-zinc-500">location</dt>
                <dd className="text-zinc-200">{resolved.location_id}</dd>
              </>
            ) : null}
            {resolved.drawing || resolved.drawing_id ? (
              <>
                <dt className="text-zinc-500">drawing</dt>
                <dd className="text-zinc-200">
                  {resolved.drawing ?? ""}
                  {resolved.drawing_id ? ` (${resolved.drawing_id})` : ""}
                </dd>
              </>
            ) : null}
            {fact?.revision ? (
              <>
                <dt className="text-zinc-500">revision</dt>
                <dd className="text-zinc-200">{fact.revision}</dd>
              </>
            ) : null}
            {fact?.issued_on ? (
              <>
                <dt className="text-zinc-500">issued</dt>
                <dd className="text-zinc-200">{fact.issued_on}</dd>
              </>
            ) : null}
            {fact?.via_rfi != null && fact.via_rfi !== false ? (
              <>
                <dt className="text-zinc-500">via RFI</dt>
                <dd className="text-zinc-200">{String(fact.via_rfi)}</dd>
              </>
            ) : null}
            {fact?.value != null ? (
              <>
                <dt className="text-zinc-500">expected</dt>
                <dd className="text-zinc-200">
                  {String(fact.value)}
                  {fact.unit ? ` ${fact.unit}` : ""}
                  {fact.tolerance != null ? ` ± ${String(fact.tolerance)}` : ""}
                </dd>
              </>
            ) : null}
            {fact?.code_ref ? (
              <>
                <dt className="text-zinc-500">code ref</dt>
                <dd className="text-zinc-200">{fact.code_ref}</dd>
              </>
            ) : null}
          </dl>
        </Card>
      ) : null}

      {/* Missing details */}
      {missing.length ? (
        <Card tone="amber" title="Missing Info">
          <p className="text-xs text-amber-200">
            {missing.map((m) => m.detail).join(" · ")}
          </p>
        </Card>
      ) : null}

      {/* Logged observation */}
      {loggedId ? (
        <Card tone="green" title="Confirmed Logged">
          <span className="text-xs font-mono text-emerald-200">ID: {loggedId}</span>
        </Card>
      ) : null}

      {/* Voice decision hints */}
      {allowed.length ? (
        <div className="glass-panel p-3 text-center">
          <p className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 mb-1">
            Voice Action Command
          </p>
          <p className="text-xs text-zinc-300">
            Say:{" "}
            <span className="text-white font-medium">
              {allowed.map((d) => DECISION_HINTS[d] ?? `"${d}"`).join(" · ")}
            </span>
          </p>
        </div>
      ) : null}
    </>
  );
}

function SiteMemoryPanel({ brief }: { brief: SiteBrief | null }) {
  const [open, setOpen] = useState(false);
  const [logsExpanded, setLogsExpanded] = useState<Record<number, boolean>>({});

  if (!brief) return null;

  const project = brief.project ?? {};
  const holdPoints = brief.open_hold_points ?? [];
  const permitsBlocked = (brief.active_permits ?? []).filter(
    (p) => (p.unsatisfied_mandatory_checks ?? []).length > 0
  );
  const openRfis = (brief.open_rfis ?? []).filter(
    (r) => (r.status ?? "").toLowerCase() === "open"
  );
  const dailyLogs = brief.recent_daily_logs ?? [];
  const observations = brief.recent_observations ?? [];
  const drawings = brief.current_drawings ?? [];
  const submittals = brief.pending_submittals ?? [];

  const attentionCount = holdPoints.length + permitsBlocked.length + openRfis.length;

  const summaryParts = [
    openRfis.length ? `${openRfis.length} open RFI${openRfis.length === 1 ? "" : "s"}` : null,
    holdPoints.length
      ? `${holdPoints.length} hold point${holdPoints.length === 1 ? "" : "s"}`
      : null,
    permitsBlocked.length
      ? `${permitsBlocked.length} permit${permitsBlocked.length === 1 ? "" : "s"} blocked`
      : null,
  ].filter(Boolean);

  return (
    <div className="flex flex-col gap-2">
      {/* Always-visible summary strip */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="glass-panel px-3 py-2 flex items-center justify-between gap-2 text-left w-full"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className={`p-live-dot ${attentionCount ? "dot-amber" : ""}`} />
          <span className="text-xs text-zinc-300 truncate">
            {summaryParts.length ? (
              summaryParts.join(" · ")
            ) : (
              <span className="text-zinc-500">Site memory loaded</span>
            )}
          </span>
        </div>
        <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 shrink-0">
          {open ? "Hide" : "Site memory"}
        </span>
      </button>

      {open ? (
        <Card title="Site Memory">
          <div className="flex flex-col gap-3">
            {/* Header line */}
            <div>
              <p className="text-sm font-medium text-white">
                {project.name ?? "Project"}
              </p>
              {brief.today_is ? (
                <p className="text-[10.5px] font-mono text-zinc-500">
                  as of {brief.today_is}
                </p>
              ) : null}
            </div>

            {/* Needs attention */}
            {attentionCount ? (
              <div className="flex flex-col gap-1.5">
                <p className="text-[10.5px] font-mono uppercase tracking-wider text-amber-300/80">
                  Needs attention
                </p>
                <div className="flex flex-col gap-1.5">
                  {holdPoints.map((h, i) => (
                    <div
                      key={`hp-${i}`}
                      className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5"
                    >
                      <p className="text-xs text-amber-100 font-mono">
                        {h.instance_id ?? "hold point"} · {h.location_id ?? "—"} ·{" "}
                        {h.planned_activity ?? "—"} planned {h.planned_for ?? "—"}
                      </p>
                      {h.notes ? (
                        <p className="text-[11px] text-amber-200/80 mt-0.5">{h.notes}</p>
                      ) : null}
                    </div>
                  ))}
                  {permitsBlocked.map((p, i) => (
                    <div
                      key={`pm-${i}`}
                      className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5"
                    >
                      <p className="text-xs text-amber-100 font-mono">
                        {p.permit_id ?? "permit"} ({p.permit_type ?? "—"}) at{" "}
                        {p.location_id ?? "—"}
                      </p>
                      <p className="text-[11px] text-amber-200/80 mt-0.5">
                        {(p.unsatisfied_mandatory_checks ?? []).join(" · ")}
                      </p>
                    </div>
                  ))}
                  {openRfis.map((r, i) => (
                    <div
                      key={`rfi-${i}`}
                      className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5"
                    >
                      <p className="text-xs text-zinc-200 font-mono">
                        {r.rfi_id ?? "RFI"} — {r.subject ?? "—"}
                      </p>
                      {r.impact ? (
                        <p className="text-[11px] text-zinc-400 mt-0.5">{r.impact}</p>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {/* Recent work */}
            {dailyLogs.length ? (
              <div className="flex flex-col gap-1.5">
                <p className="text-[10.5px] font-mono uppercase tracking-wider text-zinc-500">
                  Recent work
                </p>
                <div className="flex flex-col gap-1">
                  {dailyLogs.map((l, i) => {
                    const expanded = !!logsExpanded[i];
                    const full = l.work_done ?? "";
                    const isLong = full.length > 160;
                    return (
                      <div key={`log-${i}`} className="text-xs">
                        <span className="text-zinc-500 font-mono">{l.log_date ?? "—"}</span>{" "}
                        <span className="text-zinc-300">
                          {expanded ? full : truncate(full, 160)}
                        </span>
                        {isLong ? (
                          <button
                            type="button"
                            onClick={() =>
                              setLogsExpanded((s) => ({ ...s, [i]: !s[i] }))
                            }
                            className="ml-1 text-[10.5px] text-zinc-500 underline underline-offset-2"
                          >
                            {expanded ? "less" : "more"}
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {/* Last logged observations */}
            {observations.length ? (
              <div className="flex flex-col gap-1.5">
                <p className="text-[10.5px] font-mono uppercase tracking-wider text-zinc-500">
                  Last logged observations
                </p>
                <div className="flex flex-col gap-1">
                  {observations.map((o, i) => (
                    <p key={`obs-${i}`} className="text-xs text-zinc-300">
                      {o.location_id ?? "—"} {o.element ?? ""} {o.attribute ?? ""}{" "}
                      {slotText(o.value_claimed)}
                      {o.unit ?? ""} → {o.drawing_id ?? "—"}{" "}
                      <span className="text-zinc-500 font-mono">
                        ({o.observation_id ?? "—"}
                        {o.on_date ? `, ${o.on_date}` : ""})
                      </span>
                    </p>
                  ))}
                </div>
              </div>
            ) : null}

            {/* Current drawings */}
            {drawings.length ? (
              <div className="flex flex-col gap-1.5">
                <p className="text-[10.5px] font-mono uppercase tracking-wider text-zinc-500">
                  Current drawings
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {drawings.map((d, i) => (
                    <Chip
                      key={`dwg-${i}`}
                      label={`${d.drawing_number ?? "—"} ${d.revision ?? ""}`.trim()}
                    />
                  ))}
                </div>
              </div>
            ) : null}

            {/* Pending submittals */}
            {submittals.length ? (
              <div className="flex flex-col gap-1.5">
                <p className="text-[10.5px] font-mono uppercase tracking-wider text-zinc-500">
                  Pending submittals
                </p>
                <div className="flex flex-col gap-0.5">
                  {submittals.map((s, i) => (
                    <p key={`sub-${i}`} className="text-xs text-zinc-300">
                      {s.material ?? "—"}{" "}
                      <span className="text-zinc-500">
                        ({s.status ?? "—"}
                        {s.comments ? ` — ${s.comments}` : ""})
                      </span>
                    </p>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
