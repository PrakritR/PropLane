"use client";

import { useEffect, useRef } from "react";
import { usePortalSession } from "@/hooks/use-portal-session";

// Memory-only: retains File objects while the page stays open, never writes PII
// or payment details to persistent browser storage. Each caller scopes by actor + record.
const drafts = new Map<string, unknown>();
export function hasWorkspaceDraft(scope: string): boolean { return drafts.has(scope); }
export function clearWorkspaceDraft(scope: string): void { drafts.delete(scope); }
/** Vitest helper — module-level draft map survives `cleanup()` across cases. */
export function clearAllWorkspaceDrafts(): void {
  drafts.clear();
}

/** Closing keeps the exact typed state; only a successful commit clears it. */
export function useWorkspaceDraft<T>({ scope: formScope, actor, open = true, value, restore }: {
  scope: string;
  actor?: string | null;
  open?: boolean;
  value: T;
  restore: (value: T) => void;
}) {
  const session = usePortalSession();
  const actorId = actor ?? session.userId;
  const scope = `${actorId ?? "signed-out"}:${formScope}`;
  const preserved = useRef(false);
  const latest = useRef({ scope, open, value, restore });
  latest.current = { scope, open, value, restore };
  const cleared = useRef(false);
  useEffect(() => {
    if (!open || !actorId) return;
    cleared.current = false;
    preserved.current = false;
    const saved = drafts.get(scope) as T | undefined;
    if (saved !== undefined) latest.current.restore(saved);
    return () => {
      if (!cleared.current && !preserved.current) drafts.set(scope, latest.current.value);
    };
  }, [scope, open, actorId]);
  return {
    hasDraft: Boolean(actorId && drafts.has(scope)),
    preserve: () => { if (actorId) { drafts.set(scope, latest.current.value); preserved.current = true; } },
    clear: () => { cleared.current = true; drafts.delete(scope); },
  };
}
