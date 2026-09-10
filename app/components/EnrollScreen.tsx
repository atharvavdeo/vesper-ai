"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { Card, ErrorBanner } from "@/components/ui";

type VoiceStatus = {
  enabled: boolean;
  reachable: boolean;
  enrolled: boolean;
  threshold: number;
};

const TAKE_SECONDS = 6;
const PROMPTS = [
  "Say: “Column C-5 pe rebar spacing check kiya, drawing A-102 revision R4.”",
  "Say: “Beam B-12 ka concrete cover theek hai, drawing S-201 revision R2.”",
  "Say: “Slab level 3 pe crack dekha, drawing A-305 revision R1.”",
];

export default function EnrollScreen({
  onEnrolledChange,
}: {
  onEnrolledChange?: (enrolled: boolean) => void;
}) {
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [statusErr, setStatusErr] = useState<string | null>(null);
  const [clips, setClips] = useState<(Blob | null)[]>([null, null, null]);
  const [recordingIdx, setRecordingIdx] = useState<number | null>(null);
  const [countdown, setCountdown] = useState(0);
  const [enrolling, setEnrolling] = useState(false);
  const [enrollErr, setEnrollErr] = useState<string | null>(null);
  const [result, setResult] = useState<{
    samples: number;
    cohesion: number;
  } | null>(null);
  const [done, setDone] = useState(false);

  const mrRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadStatus = useCallback(async () => {
    setStatusErr(null);
    try {
      const s = await api.voiceStatus();
      setStatus(s);
      onEnrolledChange?.(s.enrolled);
    } catch (e) {
      setStatusErr((e as Error).message);
    }
  }, [onEnrolledChange]);

  useEffect(() => {
    void loadStatus();
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [loadStatus]);

  const stopTake = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (mrRef.current && mrRef.current.state !== "inactive") {
      mrRef.current.stop();
    }
  }, []);

  const startTake = useCallback(
    async (idx: number) => {
      setEnrollErr(null);
      setResult(null);
      setDone(false);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        streamRef.current = stream;
        chunksRef.current = [];
        const mr = new MediaRecorder(stream, { mimeType: "audio/webm" });
        mrRef.current = mr;
        mr.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data);
        };
        mr.onstop = () => {
          const blob = new Blob(chunksRef.current, { type: "audio/webm" });
          streamRef.current?.getTracks().forEach((t) => t.stop());
          streamRef.current = null;
          setClips((prev) => {
            const next = [...prev];
            next[idx] = blob.size > 0 ? blob : null;
            return next;
          });
          setRecordingIdx(null);
          setCountdown(0);
        };
        mr.start();
        setRecordingIdx(idx);
        setCountdown(TAKE_SECONDS);
        timerRef.current = setInterval(() => {
          setCountdown((c) => {
            if (c <= 1) {
              stopTake();
              return 0;
            }
            return c - 1;
          });
        }, 1000);
      } catch (e) {
        setEnrollErr(`Microphone unavailable: ${(e as Error).message}`);
      }
    },
    [stopTake],
  );

  const capturedCount = clips.filter(Boolean).length;

  const enroll = async () => {
    const blobs = clips.filter((b): b is Blob => b != null);
    if (blobs.length < 3) return;
    setEnrolling(true);
    setEnrollErr(null);
    setResult(null);
    try {
      const r = await api.voiceEnroll(blobs);
      setResult({ samples: r.samples, cohesion: r.cohesion });
      if (r.enrolled) {
        setDone(true);
        await loadStatus();
      }
    } catch (e) {
      setEnrollErr((e as Error).message);
    } finally {
      setEnrolling(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 p-4 pb-28">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Enroll</h1>
        <button
          onClick={loadStatus}
          className="rounded border border-zinc-600 px-2 py-1 text-xs"
        >
          Refresh
        </button>
      </header>

      <ErrorBanner msg={statusErr} />

      {status ? (
        <Card title="Voice ID status">
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <span>enabled: {String(status.enabled)}</span>
            <span>reachable: {String(status.reachable)}</span>
            <span
              className={
                status.enrolled ? "text-emerald-400" : "text-amber-400"
              }
            >
              enrolled: {String(status.enrolled)}
            </span>
            <span>threshold: {status.threshold}</span>
          </div>
        </Card>
      ) : null}

      <p className="text-sm text-zinc-300">
        Record 3 short voice samples (~{TAKE_SECONDS}s each). Re-take any that
        sound off, then enroll.
      </p>

      {[0, 1, 2].map((idx) => {
        const isRec = recordingIdx === idx;
        const captured = clips[idx] != null;
        return (
          <Card key={idx} tone={captured ? "green" : "neutral"}>
            <div className="mb-2 text-xs text-zinc-400">Take {idx + 1}</div>
            <p className="mb-2 text-sm">{PROMPTS[idx]}</p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => (isRec ? stopTake() : startTake(idx))}
                disabled={recordingIdx != null && !isRec}
                className={`rounded-lg border px-3 py-2 text-sm disabled:opacity-40 ${
                  isRec
                    ? "border-red-400 bg-red-600 text-white"
                    : "border-zinc-500"
                }`}
              >
                {isRec
                  ? `Stop (${countdown}s)`
                  : captured
                    ? "Re-take"
                    : "Record"}
              </button>
              {captured && !isRec ? (
                <span className="text-xs text-emerald-400">clip captured</span>
              ) : null}
            </div>
          </Card>
        );
      })}

      <button
        onClick={enroll}
        disabled={capturedCount < 3 || enrolling}
        className="rounded-lg border border-zinc-300 bg-zinc-100 px-3 py-2 text-sm font-semibold text-black disabled:opacity-40"
      >
        {enrolling
          ? "Enrolling…"
          : `Enroll (${capturedCount}/3 clips)`}
      </button>

      <ErrorBanner msg={enrollErr} />

      {result ? (
        <Card tone={done ? "green" : "neutral"} title="Enroll result">
          <div>samples: {result.samples}</div>
          <div>cohesion: {result.cohesion}</div>
          {done ? (
            <div className="mt-1 font-semibold text-emerald-400">
              {"✅"} enrolled
            </div>
          ) : null}
        </Card>
      ) : null}

      <p className="text-xs text-zinc-500">
        Match threshold is <code>SPEAKER_ID_THRESHOLD</code> in the server .env.
      </p>
    </div>
  );
}
