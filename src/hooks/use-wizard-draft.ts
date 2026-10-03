"use client";

import { useCallback, useEffect, useRef } from "react";
import { clearWizardDraft, readWizardDraft, writeWizardDraft } from "@/lib/wizard-draft-memory";

/**
 * Keeps a wizard's state across close and reopen (the x keeps a draft).
 *
 * `read()` is for the lazy initial state: it returns the saved draft when there is
 * one. The hook then writes every change while `dirty` and drops the draft when the
 * form is clean again, so an untouched form never leaves a draft behind.
 * `discard()` forgets it explicitly (a finished add, or Discard draft).
 */
export function useWizardDraft<T>(key: string | null, value: T, dirty: boolean) {
  // A form that has not been touched this mount must not erase the draft it is about to restore.
  const wasDirty = useRef(false);
  useEffect(() => {
    if (!key) return;
    if (dirty) {
      wasDirty.current = true;
      writeWizardDraft(key, value);
    } else if (wasDirty.current) {
      wasDirty.current = false;
      clearWizardDraft(key);
    }
  }, [key, value, dirty]);
  const discard = useCallback(() => {
    if (key) clearWizardDraft(key);
  }, [key]);
  return { discard };
}

export function readSavedWizardDraft<T>(key: string | null): T | undefined {
  return key ? readWizardDraft<T>(key) : undefined;
}
