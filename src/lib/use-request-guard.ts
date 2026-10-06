"use client";

import { useMemo, useRef } from "react";

/**
 * Latest-request guard for async handlers: `begin(target)` supersedes every
 * earlier request, `cancel()` invalidates the in-flight one, and
 * `isCurrent(epoch, target)` tells a late response whether it still owns the
 * UI. Kept in a hook so the mutable epoch is never read during render.
 */
export function useRequestGuard() {
  const epoch = useRef(0);
  const target = useRef<string | null>(null);
  return useMemo(() => ({
    begin(next: string | null): number {
      epoch.current += 1;
      target.current = next;
      return epoch.current;
    },
    cancel(): void {
      epoch.current += 1;
      target.current = null;
    },
    isCurrent(at: number, expected: string | null): boolean {
      return epoch.current === at && target.current === expected;
    },
  }), []);
}
