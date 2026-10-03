"use client";

/**
 * Small motion pieces shared by the resident flow and the builder's preview. Plain CSS
 * transitions on the app's motion tokens (`ui/motion/tokens.css`); no animation library.
 */
import { useEffect, useState } from "react";
import { useReducedMotion } from "@/components/ui/motion/use-reduced-motion";

/** The progress bar: eases to its new width instead of jumping. */
export function MoveInProgressBar({ ratio, label }: { ratio: number; label: string }) {
  const pct = Math.round(Math.min(Math.max(ratio, 0), 1) * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className="h-1.5 w-full overflow-hidden rounded-full bg-accent"
    >
      <div
        className="h-full rounded-full bg-primary transition-[width] duration-(--motion-slow) ease-(--motion-fill) motion-reduce:transition-none"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/** A check mark that draws itself: a stroke-dashoffset transition, no animation library. */
export function CheckDraw({ className, animate = true }: { className?: string; animate?: boolean }) {
  const reduced = useReducedMotion();
  const [drawn, setDrawn] = useState(!animate);
  useEffect(() => {
    if (drawn) return;
    if (reduced) {
      const id = window.setTimeout(() => setDrawn(true), 0);
      return () => window.clearTimeout(id);
    }
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setDrawn(true));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [drawn, reduced]);
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path
        d="M5 12.5l4.5 4.5L19 7.5"
        pathLength={1}
        style={{
          strokeDasharray: 1,
          strokeDashoffset: drawn ? 0 : 1,
          transition: reduced ? "none" : "stroke-dashoffset var(--motion-panel) var(--motion-fill)",
        }}
      />
    </svg>
  );
}
