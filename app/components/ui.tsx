"use client";

import type { ReactNode } from "react";

export function Card({
  tone = "neutral",
  title,
  children,
}: {
  tone?: "neutral" | "red" | "amber" | "green";
  title?: string;
  children: ReactNode;
}) {
  const tones: Record<string, string> = {
    neutral: "border-zinc-700 bg-zinc-900",
    red: "border-red-600 bg-red-950/60",
    amber: "border-amber-500 bg-amber-950/50",
    green: "border-emerald-600 bg-emerald-950/50",
  };
  return (
    <div className={`rounded-lg border p-3 text-sm ${tones[tone]}`}>
      {title ? (
        <div className="mb-1 font-semibold uppercase tracking-wide text-xs opacity-80">
          {title}
        </div>
      ) : null}
      {children}
    </div>
  );
}

export function ErrorBanner({ msg }: { msg: string | null }) {
  if (!msg) return null;
  return (
    <div className="rounded-lg border border-red-600 bg-red-950/70 p-3 text-sm text-red-200 whitespace-pre-wrap break-words">
      {msg}
    </div>
  );
}

export function Chip({
  label,
  dim,
}: {
  label: string;
  dim?: boolean;
}) {
  return (
    <span
      className={`inline-block rounded-full border px-2.5 py-1 text-xs ${
        dim
          ? "border-zinc-700 text-zinc-500"
          : "border-zinc-500 text-zinc-100"
      }`}
    >
      {label}
    </span>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="text-xs text-zinc-400">{label ?? "Loading…"}</div>
  );
}
