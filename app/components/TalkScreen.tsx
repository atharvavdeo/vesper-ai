"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  type DecisionKey,
  type DecisionResponse,
  type Health,
  type TurnResponse,
} from "@/lib/api";
import { Card, Chip, ErrorBanner } from "@/components/ui";

const DECISION_LABELS: Record<DecisionKey, string> = {
  log_observation: "Log observation",
  raise_rfi: "Raise RFI",
  raise_ncr: "Raise NCR",
  stop_work: "Stop work",
  cancel: "Cancel",
};

// Minimal shape of the Web Speech API we use.
type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((ev: {
    resultIndex: number;
    results: ArrayLike<
      ArrayLike<{ transcript: string }> & { isFinal: boolean }
    >;
  }) => void) | null;
  onspeechstart: (() => void) | null;
  onerror: ((ev: { error: string }) => void) | null;
  onend: (() => void) | null;
};

function getSR(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    SpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.webkitSpeechRecognition ?? w.SpeechRecognition ?? null;
}

export default function TalkScreen({
  sessionId,
  health,
  sessionError,
  voiceEnrolled,
  onGoToEnroll,
}: {
  sessionId: string | null;
  health: Health | null;
  sessionError: string | null;
  voiceEnrolled?: boolean | null;
  onGoToEnroll?: () => void;
}) {
  const [lang, setLang] = useState<"en-IN" | "hi-IN">("en-IN");
  const [listening, setListening] = useState(false);
  const [liveTranscript, setLiveTranscript] = useState("");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [resp, setResp] = useState<TurnResponse | null>(null);
  const [decisionResult, setDecisionResult] = useState<DecisionResponse | null>(
    null,
  );
  const [ttsMissing, setTtsMissing] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  // client-only capability detection — must NOT run during render (SSR hydration)
  const [mounted, setMounted] = useState(false);
  const [srSupported, setSrSupported] = useState(false);
  const [micSupported, setMicSupported] = useState(false);
  const sttViaServerRef = useRef(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const finalTranscriptRef = useRef("");
  const bargeInRef = useRef(false);
  const audioUrlRef = useRef<string | null>(null);

  useEffect(() => {
    setMounted(true);
    const sr = getSR() != null;
    setSrSupported(sr);
    setMicSupported(
      typeof navigator !== "undefined" &&
        !!navigator.mediaDevices &&
        typeof MediaRecorder !== "undefined",
    );
    sttViaServerRef.current = !sr; // no Web Speech API -> always transcribe server-side
  }, []);

  const stopPlayback = useCallback(() => {
    if (audioRef.current && !audioRef.current.paused) {
      audioRef.current.pause();
    }
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    setSpeaking(false);
  }, []);

  // Barge-in: if the agent is speaking, cut it and flag this turn.
  const maybeBargeIn = useCallback(() => {
    if (speaking || (audioRef.current && !audioRef.current.paused)) {
      bargeInRef.current = true;
      stopPlayback();
    }
  }, [speaking, stopPlayback]);

  const playTts = useCallback(
    async (text: string) => {
      if (!text) return;
      setTtsMissing(false);
      const out = await api.tts(text);
      if (out.ok) {
        if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
        const url = URL.createObjectURL(out.blob);
        audioUrlRef.current = url;
        let el = audioRef.current;
        if (!el) {
          el = new Audio();
          audioRef.current = el;
        }
        el.src = url;
        el.onplay = () => setSpeaking(true);
        el.onended = () => setSpeaking(false);
        el.onpause = () => setSpeaking(false);
        try {
          await el.play();
        } catch {
          /* autoplay may be blocked until a user gesture */
        }
        return;
      }
      // Fallback path.
      setTtsMissing(true);
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        const u = new SpeechSynthesisUtterance(text);
        const voices = window.speechSynthesis.getVoices();
        const hi = voices.find((v) => v.lang === "hi-IN" || v.lang === "hi_IN");
        if (hi) u.voice = hi;
        u.onstart = () => setSpeaking(true);
        u.onend = () => setSpeaking(false);
        window.speechSynthesis.speak(u);
      }
    },
    [],
  );

  const sendTurn = useCallback(
    async (args: { text: string; audio?: Blob; bargeIn: boolean }) => {
      if (!sessionId) {
        setErr("No session — cannot send turn.");
        return;
      }
      const text = args.text.trim();
      if (!text) return;
      setBusy(true);
      setErr(null);
      setDecisionResult(null);
      try {
        const r = args.audio
          ? await api.turnMultipart({
              sessionId,
              text,
              bargeIn: args.bargeIn,
              audio: args.audio,
            })
          : await api.turnJson({ sessionId, text, bargeIn: args.bargeIn });
        setResp(r);
        const speech = r.reply?.speech || r.reply?.text || "";
        void playTts(speech);
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy(false);
        bargeInRef.current = false;
      }
    },
    [sessionId, playTts],
  );

  // ---- Mic capture (SpeechRecognition + MediaRecorder in parallel) ----
  const stopMic = useCallback(() => {
    setListening(false);
    try {
      recognitionRef.current?.stop();
    } catch {
      /* noop */
    }
    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state !== "inactive"
    ) {
      mediaRecorderRef.current.stop(); // triggers onstop -> send
    }
  }, []);

  const startMic = useCallback(async () => {
    setErr(null);
    const SR = getSR(); // optional — MediaRecorder + server STT works without it
    finalTranscriptRef.current = "";
    bargeInRef.current = false;
    setLiveTranscript("");

    // Audio stream + recorder
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const mr = new MediaRecorder(stream, { mimeType: "audio/webm" });
      mediaRecorderRef.current = mr;
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      mr.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        let text = (finalTranscriptRef.current || liveTranscript).trim();
        // No usable browser transcript -> transcribe the recording server-side (Groq Whisper).
        if (!text && blob.size > 0 && (sttViaServerRef.current || !srSupported)) {
          setBusy(true);
          try {
            const out = await api.stt(blob, lang.startsWith("hi") ? "hi" : "en");
            text = (out.text || "").trim();
            if (text) setLiveTranscript(text);
          } catch (e) {
            setErr(`Transcription failed: ${(e as Error).message}`);
          } finally {
            setBusy(false);
          }
        }
        if (!text) {
          setErr("Nothing heard — try again or use the text box.");
          return;
        }
        void sendTurn({
          text,
          audio: blob.size > 0 ? blob : undefined,
          bargeIn: bargeInRef.current,
        });
      };
      mr.start();
    } catch (e) {
      setErr(`Microphone unavailable: ${(e as Error).message}`);
      return;
    }

    if (!SR) {
      // No Web Speech API (typical on Linux Chromium). MediaRecorder is already running;
      // onstop will transcribe via /api/stt. Nothing else to wire up.
      setListening(true);
      return;
    }

    const rec = new SR();
    recognitionRef.current = rec;
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.onspeechstart = () => {
      maybeBargeIn();
    };
    rec.onresult = (ev) => {
      let interim = "";
      let final = finalTranscriptRef.current;
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        const chunk = res[0]?.transcript ?? "";
        if (res.isFinal) final += chunk;
        else interim += chunk;
      }
      if (interim) maybeBargeIn();
      finalTranscriptRef.current = final;
      setLiveTranscript((final + " " + interim).trim());
    };
    rec.onerror = (ev) => {
      // 'network' / 'service-not-allowed' -> the browser STT backend is unreachable
      // (common on Linux Chromium). Fall back to server STT silently for this + future turns.
      if (
        ev.error === "network" ||
        ev.error === "service-not-allowed" ||
        ev.error === "language-not-supported"
      ) {
        sttViaServerRef.current = true;
        return;
      }
      if (ev.error !== "no-speech" && ev.error !== "aborted") {
        setErr(`Speech recognition error: ${ev.error}`);
      }
    };
    rec.onend = () => {
      // webkitSpeechRecognition self-stops after a short silence (or instantly on a
      // Linux 'network' error). We do NOT end the turn here — the user taps to send.
      // Keep the recognizer alive while the recorder is still running.
      if (mediaRecorderRef.current?.state === "recording") {
        try {
          rec.start();
        } catch {
          sttViaServerRef.current = true; // fall through to server STT on final stop
        }
      }
    };
    try {
      rec.start();
      setListening(true);
    } catch (e) {
      setErr(`Could not start recognition: ${(e as Error).message}`);
    }
  }, [lang, liveTranscript, maybeBargeIn, sendTurn, stopMic, srSupported]);

  useEffect(() => {
    return () => {
      try {
        recognitionRef.current?.abort();
      } catch {
        /* noop */
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    };
  }, []);

  const submitTyped = () => {
    maybeBargeIn();
    void sendTurn({ text: typed, bargeIn: bargeInRef.current });
    setTyped("");
  };

  const onDecision = async (d: DecisionKey) => {
    if (!sessionId) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.decision(sessionId, d);
      setDecisionResult(r);
      const speech = r.reply?.speech || r.reply?.text || "";
      void playTts(speech);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const entities = resp?.entities ?? [];
  const contradictions = resp?.contradictions ?? [];
  const blockers = resp?.blockers ?? [];
  const allowed = resp?.allowedDecisions ?? [];
  const speakerLocked = resp?.speaker && resp.speaker.match === false;

  return (
    <div className="flex flex-col gap-4 p-4 pb-28">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Talk</h1>
        <div className="flex items-center gap-2 text-xs">
          {health ? (
            <span className="text-zinc-400">
              llm:{health.llm} {health.rime ? "· rime" : ""}{" "}
              {health.voiceid ? "· voiceid" : ""}
            </span>
          ) : null}
          {ttsMissing ? (
            <span className="rounded bg-amber-800 px-2 py-0.5 text-amber-100">
              Rime key missing
            </span>
          ) : null}
        </div>
      </header>

      <ErrorBanner msg={sessionError} />
      {!sessionId && !sessionError ? (
        <div className="text-xs text-zinc-400">Starting session…</div>
      ) : null}

      {/* language toggle */}
      <div className="flex gap-2">
        {(["en-IN", "hi-IN"] as const).map((l) => (
          <button
            key={l}
            onClick={() => setLang(l)}
            className={`rounded-full border px-3 py-1 text-sm ${
              lang === l
                ? "border-zinc-100 bg-zinc-100 text-black"
                : "border-zinc-600 text-zinc-300"
            }`}
          >
            {l}
          </button>
        ))}
        {speaking ? (
          <span className="self-center text-xs text-emerald-400">
            agent speaking…
          </span>
        ) : null}
      </div>

      {/* push to talk */}
      <button
        onClick={() => {
          if (busy) return;
          if (listening) stopMic();
          else void startMic();
        }}
        disabled={!sessionId || busy || (mounted && !micSupported)}
        className={`mx-auto flex h-40 w-40 select-none items-center justify-center rounded-full border-4 text-center text-base font-semibold transition ${
          listening
            ? "border-red-400 bg-red-600 text-white"
            : "border-zinc-600 bg-zinc-800 text-zinc-100"
        } disabled:opacity-40`}
      >
        {listening ? "Listening…\ntap to send" : "Tap to talk"}
      </button>
      {mounted && !micSupported ? (
        <p className="text-center text-xs text-amber-400">
          Microphone/recording unavailable — use the text box below.
        </p>
      ) : mounted && !srSupported ? (
        <p className="text-center text-xs text-zinc-500">
          Using server transcription (browser speech API unavailable).
        </p>
      ) : null}
      {voiceEnrolled === false ? (
        <p className="text-center text-xs text-zinc-500">
          Voice not enrolled —{" "}
          <button
            onClick={onGoToEnroll}
            className="underline underline-offset-2"
          >
            go to Enroll tab
          </button>
        </p>
      ) : null}

      {/* typed fallback — always visible */}
      <div className="flex gap-2">
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitTyped();
          }}
          placeholder="Type an observation and press Enter"
          className="flex-1 rounded-lg border border-zinc-600 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-zinc-300"
        />
        <button
          onClick={submitTyped}
          disabled={!sessionId || busy || !typed.trim()}
          className="rounded-lg border border-zinc-500 px-3 py-2 text-sm disabled:opacity-40"
        >
          Send
        </button>
      </div>

      {busy ? <div className="text-xs text-zinc-400">Working…</div> : null}
      <ErrorBanner msg={err} />

      {/* live transcript */}
      {liveTranscript ? (
        <Card title="Transcript">
          <p className="whitespace-pre-wrap">{liveTranscript}</p>
        </Card>
      ) : null}

      {/* speaker gate */}
      {speakerLocked ? (
        <Card tone="red">
          🔒 Speaker not verified — logging locked
          {resp?.speaker ? (
            <span className="ml-1 opacity-70">
              (score {resp.speaker.score.toFixed(2)})
            </span>
          ) : null}
        </Card>
      ) : null}

      {/* entity chips */}
      {entities.length ? (
        <div className="flex flex-wrap gap-2">
          {entities.map((en, i) => (
            <Chip
              key={`${en.label}-${i}`}
              label={en.label}
              dim={en.confidence < 0.7}
            />
          ))}
        </div>
      ) : null}

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

      {/* agent reply */}
      {resp?.reply?.text ? (
        <div className="rounded-2xl rounded-tl-sm border border-zinc-700 bg-zinc-800 p-3 text-sm">
          {resp.reply.text}
          <div className="mt-1 text-[10px] uppercase tracking-wide text-zinc-500">
            state: {resp.state}
          </div>
        </div>
      ) : null}

      {/* decision buttons */}
      {allowed.length ? (
        <div className="flex flex-wrap gap-2">
          {allowed.map((d) => (
            <button
              key={d}
              onClick={() => onDecision(d)}
              disabled={busy}
              className="rounded-lg border border-zinc-400 px-3 py-2 text-sm font-medium disabled:opacity-40"
            >
              {DECISION_LABELS[d]}
            </button>
          ))}
        </div>
      ) : null}

      {/* decision result */}
      {decisionResult ? (
        <Card tone="green" title="Decision result">
          <p>{decisionResult.reply?.text}</p>
          <p className="mt-1 text-xs text-zinc-300">
            state: {decisionResult.state}
            {decisionResult.logged
              ? ` · ${JSON.stringify(decisionResult.logged)}`
              : ""}
          </p>
        </Card>
      ) : null}
    </div>
  );
}
