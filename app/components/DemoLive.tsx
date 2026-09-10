"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Card, WaveVisualizer } from "@/components/ui";
import SiteMemoryPanel, { type SiteBrief } from "@/components/SiteMemoryPanel";
import { DEMO_LIVE } from "@/lib/demo";
import data from "@/lib/demo-data.json";

type Evidence = { drawing_number?: string; revision?: string; issued_on?: string; expected?: number; tolerance?: number; claimed?: number; unit?: string; code_ref?: string };
type Issue = { kind: string; detail: string; evidence?: Evidence };

const LABELS: Record<string, string> = {
  log_observation: "Log observation",
  raise_rfi: "Raise RFI",
  raise_ncr: "Raise NCR",
  cancel: "Cancel",
};

const NCR_DONE = (data.flows as unknown as Record<string, { decision?: string; response: { reply: { text: string } } }[]>)
  .cover_ncr.find((s) => s.decision === "raise_ncr")?.response.reply.text;

/**
 * The Live screen for the public demo: replays a recorded live conversation (real engine
 * output, see scripts/build_demo_data.py) with the same controls as a LiveKit room.
 */
export default function DemoLive() {
  const script = DEMO_LIVE.script;
  const [shown, setShown] = useState(0);
  const [typing, setTyping] = useState("");
  const [micOn, setMicOn] = useState(true);
  const [decided, setDecided] = useState<string | null>(null);
  const timers = useRef<number[]>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const clear = () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  };

  const play = useCallback(() => {
    clear();
    setShown(0);
    setTyping("");
    setDecided(null);
    let at = 400;
    script.forEach((row, i) => {
      if (row.who === "Vesper") {
        // Vesper "speaks": reveal word by word, like the live transcription stream
        const words = row.text.split(" ");
        words.forEach((_, w) => {
          timers.current.push(window.setTimeout(() => setTyping(words.slice(0, w + 1).join(" ")), at + w * 55));
        });
        at += words.length * 55 + 500;
      } else {
        at += 700;
      }
      timers.current.push(window.setTimeout(() => {
        setTyping("");
        setShown(i + 1);
      }, at));
      at += 350;
    });
  }, [script]);

  useEffect(() => {
    const start = window.setTimeout(play, 0); // start after mount, not during the effect
    // the guided tour skips the replay so its later steps have something to point at
    const finish = () => {
      clear();
      setTyping("");
      setShown(script.length);
    };
    window.addEventListener("vesper-demo-finish", finish);
    return () => {
      window.clearTimeout(start);
      clear();
      window.removeEventListener("vesper-demo-finish", finish);
    };
  }, [play, script.length]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [shown, typing]);

  const done = shown >= script.length;
  const speaking = typing !== "";
  const engine = (DEMO_LIVE.engine ?? {}) as { contradictions?: Issue[]; allowedDecisions?: string[] };
  const issues = engine.contradictions ?? [];
  const allowed = engine.allowedDecisions ?? [];
  const ev = issues[0]?.evidence;

  return (
    <div className="flex flex-col gap-3">
      <div id="tour-live-controls" className="glass-panel flex items-center gap-3 px-3 py-2">
        <span className="p-live-dot" />
        <span className="w-[70px] shrink-0 font-mono text-[10px] uppercase tracking-wider text-zinc-400">
          {!micOn ? "mic off" : speaking ? "speaking" : done ? "listening" : "thinking"}
        </span>
        <div className="flex h-7 flex-1 items-center">
          <WaveVisualizer active={speaking} />
        </div>
        <button
          type="button"
          onClick={() => setMicOn((m) => !m)}
          aria-pressed={!micOn}
          aria-label={micOn ? "Mute my microphone" : "Unmute my microphone"}
          className={`grid h-8 w-8 shrink-0 place-items-center rounded-full border transition ${
            micOn ? "border-white/20 bg-white/5 text-zinc-200 hover:bg-white/10" : "border-red-400/60 bg-red-500/20 text-red-200"
          }`}
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" x2="12" y1="19" y2="22" />
            {micOn ? null : <line x1="3" y1="3" x2="21" y2="21" />}
          </svg>
        </button>
        <button type="button" onClick={play} className="shrink-0 rounded-full border border-white/15 px-2.5 py-1 text-[11px] text-zinc-300 hover:text-white">
          Replay
        </button>
      </div>

      <p className="px-1 font-mono text-[10px] text-zinc-500">voice out: rime mistv3 · cove · websocket (recorded demo plays text only)</p>

      <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 font-mono text-[11px] text-emerald-200">
        Voice verified · 0.86 — writes unlocked for this manager
      </div>

      <div id="tour-site-memory">
        <SiteMemoryPanel brief={DEMO_LIVE.brief as SiteBrief} />
      </div>

      <div id="tour-live-transcript">
        <Card title="Live transcript">
          <div ref={scrollRef} className="flex max-h-[380px] flex-col gap-2.5 overflow-y-auto">
            {script.slice(0, shown).map((r, i) => (
              <Bubble key={i} who={r.who} text={r.text} />
            ))}
            {speaking ? <Bubble who="Vesper" text={typing} live /> : null}
          </div>
        </Card>
      </div>

      {done && issues.length ? (
        <div id="tour-live-evidence" className="flex flex-col gap-3">
          <Card tone="red" title="Contradiction">
            <ul className="space-y-1 text-xs text-red-100">
              {issues.map((c, i) => (
                <li key={i}>• {c.detail}</li>
              ))}
            </ul>
          </Card>
          {ev ? (
            <Card title="Evidence from the record">
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-xs">
                <dt className="text-zinc-500">drawing</dt>
                <dd className="text-zinc-200">{ev.drawing_number} {ev.revision} · issued {ev.issued_on}</dd>
                <dt className="text-zinc-500">expected</dt>
                <dd className="text-zinc-200">{ev.expected} {ev.unit} ± {ev.tolerance}</dd>
                <dt className="text-zinc-500">you said</dt>
                <dd className="text-red-200">{ev.claimed} {ev.unit}</dd>
                {ev.code_ref ? (
                  <>
                    <dt className="text-zinc-500">code</dt>
                    <dd className="text-zinc-200">{ev.code_ref}</dd>
                  </>
                ) : null}
              </dl>
            </Card>
          ) : null}
        </div>
      ) : null}

      {done ? (
        decided ? (
          <Card tone="green" title="Logged">
            <p className="text-xs text-emerald-100">{decided}</p>
          </Card>
        ) : (
          <div id="tour-live-decisions" className="flex flex-wrap gap-2">
            {allowed.map((d) => (
              <Button
                key={d}
                size="sm"
                variant={d === "raise_ncr" ? "solid" : "ghost"}
                onClick={() => setDecided(d === "raise_ncr" ? NCR_DONE ?? "NCR raised." : d === "cancel" ? "Cancelled. Nothing has been logged." : `${LABELS[d]} — in the live console this writes a linked record.`)}
              >
                {LABELS[d] ?? d}
              </Button>
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}

function Bubble({ who, text, live = false }: { who: "You" | "Vesper"; text: string; live?: boolean }) {
  return (
    <div className={`flex flex-col ${who === "You" ? "max-w-[88%] items-end self-end" : "max-w-[92%] items-start self-start"}`}>
      <span className="mb-0.5 px-1 font-mono text-[9.5px] text-zinc-500">{who}{live ? " · speaking" : ""}</span>
      <div className={who === "You" ? "bubble-user" : "bubble-agent"}>{text}</div>
    </div>
  );
}
