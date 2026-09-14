"use client";

/**
 * Autosave for popups that no longer have a Save button.
 *
 * One hook, every form: the caller hands it the current draft and a `save`,
 * and it writes 600 ms after the last change, never more than one write in
 * flight, last write wins. The four states drive the mark beside the modal
 * title (`SaveStatus`):
 *
 *   idle     nothing changed since open / last save
 *   invalid  a required field is empty — nothing is written, the mark says why
 *   saving   a write is in flight (× still works; the write finishes anyway)
 *   saved    the last write landed
 *   error    the write failed; the draft is kept, `retry()` re-sends it, and
 *            `reason` carries the server's message when it gave one
 *
 * `flush()` sends whatever is pending right now — call it from the close
 * handler so the last keystroke is not lost to the debounce window.
 *
 * Validation returns a short reason string or null. The hook never decides
 * what is required; the form does.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type AutosaveState = "idle" | "invalid" | "saving" | "saved" | "error";

export type AutosaveStatus = {
  state: AutosaveState;
  /**
   * Why the draft is not saved: the missing field (state === "invalid") or the
   * message the failed write came back with (state === "error"; null when the
   * failure had none, e.g. the network dropped).
   */
  reason: string | null;
  /** When the last write landed. */
  savedAt: number | null;
  /** Re-send the last failed draft. */
  retry: () => void;
  /** Send the pending draft now (used on close). Resolves once the write settles. */
  flush: () => Promise<void>;
  /** True while a draft is waiting for the debounce or in flight. */
  dirty: boolean;
};

export const AUTOSAVE_DEBOUNCE_MS = 600;

export function useAutosaveDraft<T>(input: {
  /** The draft to persist. Compared by `serialize` (default JSON) to skip no-op writes. */
  draft: T;
  /** Only writes while true — off until the form is hydrated from the record. */
  enabled: boolean;
  /** Short reason the draft cannot be written yet, or null when it can. */
  validate?: (draft: T) => string | null;
  /** The write. Throwing (or resolving `{ ok: false }`) puts the hook in `error`. */
  save: (draft: T) => Promise<void | { ok: boolean; error?: string }>;
  /** Fires after a successful write with the draft that was written. */
  onSaved?: (draft: T) => void;
  serialize?: (draft: T) => string;
  debounceMs?: number;
}): AutosaveStatus {
  const { draft, enabled, validate, save, onSaved, serialize, debounceMs = AUTOSAVE_DEBOUNCE_MS } = input;
  const [state, setState] = useState<AutosaveState>("idle");
  const [reason, setReason] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);

  const ser = useCallback((d: T) => (serialize ? serialize(d) : JSON.stringify(d)), [serialize]);
  const lastWrittenRef = useRef<string | null>(null);
  const pendingRef = useRef<T | null>(null);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveRef = useRef(save);
  const onSavedRef = useRef(onSaved);
  const validateRef = useRef(validate);
  const enabledRef = useRef(enabled);
  const stateRef = useRef<AutosaveState>("idle");
  useEffect(() => {
    saveRef.current = save;
    onSavedRef.current = onSaved;
    validateRef.current = validate;
    enabledRef.current = enabled;
    stateRef.current = state;
  });

  /** Baseline: the first draft seen while enabled counts as already written. */
  const baselinedRef = useRef(false);
  useEffect(() => {
    if (!enabled) {
      baselinedRef.current = false;
      lastWrittenRef.current = null;
      pendingRef.current = null;
      setState("idle");
      setReason(null);
      setDirty(false);
      if (timerRef.current) clearTimeout(timerRef.current);
      return;
    }
    if (!baselinedRef.current) {
      baselinedRef.current = true;
      lastWrittenRef.current = ser(draft);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const write = useCallback(async (): Promise<void> => {
    if (inFlightRef.current) return inFlightRef.current;
    const run = (async () => {
      // Drain: a keystroke that lands during a write is sent as its own write once
      // this one settles. After a failure the draft waits for retry() instead of
      // hammering the server.
      for (;;) {
        const next = pendingRef.current;
        if (next === null) break;
        pendingRef.current = null;
        const key = ser(next);
        if (key === lastWrittenRef.current) {
          setState((s) => (s === "saving" ? "saved" : s));
          continue;
        }
        setState("saving");
        stateRef.current = "saving";
        setReason(null);
        try {
          const result = await saveRef.current(next);
          if (result && typeof result === "object" && result.ok === false) {
            throw new Error(result.error || "Could not save.");
          }
          lastWrittenRef.current = key;
          setSavedAt(Date.now());
          setState("saved");
          stateRef.current = "saved";
          onSavedRef.current?.(next);
        } catch (error) {
          // Keep the draft so retry() can re-send exactly what failed, and the
          // message so the mark can say why ("Only the owner can…") instead of
          // a bare "Couldn't save" the user cannot act on.
          if (pendingRef.current === null) pendingRef.current = next;
          const message = error instanceof Error ? error.message.trim() : "";
          setReason(message || null);
          setState("error");
          stateRef.current = "error";
          break;
        }
      }
      setDirty(pendingRef.current !== null);
    })();
    inFlightRef.current = run;
    try {
      await run;
    } finally {
      inFlightRef.current = null;
    }
  }, [ser]);


  useEffect(() => {
    if (!enabled || !baselinedRef.current) return;
    const key = ser(draft);
    if (key === lastWrittenRef.current && pendingRef.current === null) return;
    const why = validateRef.current ? validateRef.current(draft) : null;
    if (why) {
      pendingRef.current = null;
      setReason(why);
      setState("invalid");
      setDirty(false);
      if (timerRef.current) clearTimeout(timerRef.current);
      return;
    }
    setReason(null);
    pendingRef.current = draft;
    setDirty(true);
    if (stateRef.current !== "saving") setState("idle");
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void write();
    }, debounceMs);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [draft, enabled, ser, debounceMs, write]);

  const flush = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!enabledRef.current) return;
    if (pendingRef.current === null && !inFlightRef.current) return;
    await write();
    if (inFlightRef.current) await inFlightRef.current;
  }, [write]);

  const retry = useCallback(() => {
    if (stateRef.current !== "error") return;
    void write();
  }, [write]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return { state, reason, savedAt, retry, flush, dirty };
}
