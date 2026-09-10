"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { api, type Health } from "@/lib/api";
import TalkScreen from "@/components/TalkScreen";
import ObservationsScreen from "@/components/ObservationsScreen";
import ScenariosScreen from "@/components/ScenariosScreen";
import EnrollScreen from "@/components/EnrollScreen";

// Isolated: LiveKit is browser-only and heavy. A failure here must not take
// down the rest of the app, so it's client-only and lazily loaded.
const ConversationScreen = dynamic(
  () => import("@/components/ConversationScreen"),
  {
    ssr: false,
    loading: () => (
      <div className="p-4 text-sm text-zinc-400">Loading live voice…</div>
    ),
  },
);

type Tab = "talk" | "live" | "observations" | "scenarios" | "enroll";

const TABS: { key: Tab; label: string }[] = [
  { key: "talk", label: "Talk" },
  { key: "live", label: "Live" },
  { key: "observations", label: "Observations" },
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

  return (
    <div className="app-shell">
      <main className="flex-1">
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

      <nav className="fixed inset-x-0 bottom-0 mx-auto flex max-w-[430px] border-t border-zinc-800 bg-black">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex-1 py-3 text-sm font-medium ${
              tab === t.key ? "text-zinc-100" : "text-zinc-500"
            }`}
          >
            {t.label}
            {tab === t.key ? (
              <span className="mx-auto mt-1 block h-0.5 w-8 rounded bg-zinc-100" />
            ) : null}
          </button>
        ))}
      </nav>
    </div>
  );
}
