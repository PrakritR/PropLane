"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import type { AutosaveStatus } from "@/hooks/use-autosave-draft";

function clockLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/**
 * The mark beside a modal title for a popup that saves itself.
 *
 * Reads the hook's state and says one short thing: Saving…, Saved (then
 * "Saved · 2:41 PM" after ten seconds), Couldn't save — retry, or the reason a
 * required field is holding the write back. Nothing while idle: a form that has
 * not changed has nothing to report.
 */
export function SaveStatus({ status, className }: { status: AutosaveStatus; className?: string }) {
  const { state, reason, savedAt, retry } = status;
  const [showClock, setShowClock] = useState(false);
  useEffect(() => {
    if (state !== "saved" || !savedAt) {
      setShowClock(false);
      return;
    }
    setShowClock(false);
    const t = setTimeout(() => setShowClock(true), 10_000);
    return () => clearTimeout(t);
  }, [state, savedAt]);

  if (state === "idle") return null;

  const tone =
    state === "error"
      ? "text-danger"
      : state === "invalid" || state === "saving"
        ? "text-amber-700"
        : "text-muted";
  const dot =
    state === "error"
      ? "bg-danger"
      : state === "invalid" || state === "saving"
        ? "bg-amber-500"
        : "bg-emerald-600";

  return (
    <span
      role="status"
      aria-live="polite"
      data-attr="modal-save-status"
      data-state={state}
      className={cn("inline-flex items-center gap-1.5 text-xs font-medium", tone, className)}
    >
      <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", dot)} />
      {state === "saving" ? "Saving…" : null}
      {state === "saved" ? (showClock && savedAt ? `Saved · ${clockLabel(savedAt)}` : "Saved") : null}
      {state === "invalid" ? reason ?? "Not saved yet" : null}
      {state === "error" ? (
        <>
          Couldn&apos;t save —{" "}
          <button type="button" onClick={retry} className="underline underline-offset-2">
            retry
          </button>
        </>
      ) : null}
    </span>
  );
}
