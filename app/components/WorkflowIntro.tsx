"use client";

import { useCallback, useEffect, useRef } from "react";
import { driver, type Driver } from "driver.js";
import "driver.js/dist/driver.css";

const TOUR_KEY = "vesper-workflow-intro-complete";

/** A short, restartable guide to the safety-first observation workflow. */
export default function WorkflowIntro() {
  const tourRef = useRef<Driver | null>(null);

  const startTour = useCallback(() => {
    tourRef.current?.destroy();
    const tour = driver({
      animate: true,
      allowClose: true,
      overlayColor: "#000000",
      overlayOpacity: 0.78,
      showProgress: true,
      progressText: "{{current}} / {{total}}",
      popoverClass: "vesper-workflow-tour",
      nextBtnText: "Next",
      prevBtnText: "Back",
      doneBtnText: "Start safely",
      onDestroyed: () => {
        window.localStorage.setItem(TOUR_KEY, "true");
      },
      steps: [
        {
          element: "#workflow-language",
          popover: {
            title: "1. Choose your language",
            description:
              "Use English or Hinglish before you begin. You can switch anytime; your observation stays visible as a transcript.",
            side: "bottom",
            align: "start",
          },
        },
        {
          element: "#workflow-capture",
          popover: {
            title: "2. Capture the observation",
            description:
              "Tap the mic to speak, or use the typed fallback. Speaking while Vesper replies stops the audio and marks a barge-in.",
            side: "bottom",
            align: "center",
          },
        },
        {
          element: "#workflow-suggestions",
          popover: {
            title: "3. Start with a suggested question",
            description:
              "Use the suggested prompts to explore Vesper, including the general pre-pour question. For an observation, include location, element, measurement, drawing and revision—for example: C-5 column, 180 mm, A-102 R3.",
            side: "top",
            align: "center",
          },
        },
        {
          element: "#workflow-review-area",
          popover: {
            title: "4. Verify before saving",
            description:
              "Vesper extracts the context, checks drawings and permits, then shows contradictions or blockers. Low-confidence details are never logged automatically.",
            side: "top",
            align: "center",
          },
        },
        {
          element: "#workflow-navigation",
          popover: {
            title: "5. Review the record",
            description:
              "Use Logs for saved observations, Scenarios for safe demos, and Enroll to set up manager voice verification. You are ready to start.",
            side: "top",
            align: "center",
          },
        },
      ],
    });
    tourRef.current = tour;
    tour.drive();
  }, []);

  useEffect(() => {
    if (window.localStorage.getItem(TOUR_KEY)) return;
    const timeout = window.setTimeout(startTour, 450);
    return () => {
      window.clearTimeout(timeout);
      tourRef.current?.destroy();
    };
  }, [startTour]);

  return (
    <button
      type="button"
      onClick={startTour}
      className="rounded border border-white/10 bg-white/5 px-2 py-1 text-[11px] font-mono text-zinc-400 transition-colors hover:border-white/30 hover:text-white"
      aria-label="Show workflow introduction"
    >
      Workflow guide
    </button>
  );
}
