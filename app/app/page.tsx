"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { api, type Health } from "@/lib/api";
import TalkScreen from "@/components/TalkScreen";
import ObservationsScreen from "@/components/ObservationsScreen";
import ScenariosScreen from "@/components/ScenariosScreen";
import EnrollScreen from "@/components/EnrollScreen";
import { VesperLogo, LiveBadge } from "@/components/ui";

const ConversationScreen = dynamic(
  () => import("@/components/ConversationScreen"),
  {
    ssr: false,
    loading: () => (
      <div className="flex flex-col items-center justify-center p-12 text-sm text-zinc-400 gap-3">
        <svg
          className="animate-spin h-5 w-5 text-zinc-300"
          viewBox="0 0 24 24"
          fill="none"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8v8H4z"
          />
        </svg>
        <span>Connecting live voice pipeline…</span>
      </div>
    ),
  },
);

type Tab = "talk" | "live" | "observations" | "scenarios" | "enroll";

const TABS: { key: Tab; label: string }[] = [
  { key: "talk", label: "Talk" },
  { key: "live", label: "Live" },
  { key: "observations", label: "Logs" },
  { key: "scenarios", label: "Scenarios" },
  { key: "enroll", label: "Enroll" },
];

export default function Home() {
  const [tab, setTab] = useState<Tab>("talk");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [voiceEnrolled, setVoiceEnrolled] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .createSession()
      .then((r) => {
        if (!cancelled) setSessionId(r.sessionId);
      })
      .catch((e: Error) => {
        if (!cancelled) setSessionError(`Session start failed: ${e.message}`);
      });
    api
      .health()
      .then((h) => {
        if (!cancelled) setHealth(h);
      })
      .catch(() => {
        /* health is best-effort */
      });
    api
      .voiceStatus()
      .then((s) => {
        if (!cancelled) setVoiceEnrolled(s.enrolled);
      })
      .catch(() => {
        /* voice status is best-effort */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onEnrolledChange = useCallback(
    (enrolled: boolean) => setVoiceEnrolled(enrolled),
    [],
  );

  const getSystemStatus = (): { state: "ok" | "check" | "alert"; label: string } => {
    if (sessionError) return { state: "alert", label: "OFFLINE" };
    if (!sessionId) return { state: "check", label: "CONNECTING" };
    return { state: "ok", label: "LIVE MEMORY" };
  };

  const status = getSystemStatus();

  return (
    <>
      {/* Animated Film Grain Overlay */}
      <div className="grain" aria-hidden="true" />

      {/* Subtle Ambient Background Light */}
      <div
        className="fixed top-0 left-1/2 -translate-x-1/2 w-[500px] h-[240px] pointer-events-none opacity-20 -z-10"
        style={{
          background:
            "radial-gradient(ellipse at 50% 0%, rgba(186, 208, 255, 0.25), transparent 70%)",
        }}
      />

      <div className="app-shell px-3 pt-3">
        {/* Top App Header Bar */}
        <header className="sticky top-0 z-40 mb-3 flex items-center justify-between rounded-xl px-3.5 py-2.5 backdrop-blur-xl border border-white/10 bg-black/60 shadow-[0_4px_20px_rgba(0,0,0,0.5)]">
          <div className="flex items-center gap-2.5">
            <VesperLogo size={20} />
          </div>

          <div className="flex items-center gap-2">
            <LiveBadge state={status.state} label={status.label} />
          </div>
        </header>

        {/* Main App Content View */}
        <main className="flex-1 pb-24">
          {tab === "talk" ? (
            <TalkScreen
              sessionId={sessionId}
              health={health}
              sessionError={sessionError}
              voiceEnrolled={voiceEnrolled}
              onGoToEnroll={() => setTab("enroll")}
            />
          ) : null}
          {tab === "live" ? <ConversationScreen /> : null}
          {tab === "observations" ? <ObservationsScreen /> : null}
          {tab === "scenarios" ? <ScenariosScreen /> : null}
          {tab === "enroll" ? (
            <EnrollScreen onEnrolledChange={onEnrolledChange} />
          ) : null}
        </main>

        {/* Floating Liquid-Metal Dock Navigation */}
        <nav
          aria-label="Primary Navigation"
          className="fixed inset-x-0 bottom-3 z-40 mx-auto w-[calc(100%-24px)] max-w-[430px]"
        >
          <div className="flex items-center justify-between gap-1 rounded-xl border border-white/15 bg-black/75 p-1.5 backdrop-blur-2xl shadow-[0_12px_36px_rgba(0,0,0,0.85),inset_0_1px_0_rgba(255,255,255,0.12)]">
            {TABS.map((t) => {
              const active = tab === t.key;
              return (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  aria-selected={active}
                  className={`nav-pill flex-1 text-center transition-all ${
                    active
                      ? "nav-pill-active font-medium"
                      : "opacity-70 hover:opacity-100"
                  }`}
                >
                  <span>{t.label}</span>
                </button>
              );
            })}
          </div>
        </nav>
      </div>
    </>
  );
}
