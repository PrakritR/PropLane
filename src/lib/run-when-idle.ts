/**
 * Run `task` after the page is interactive, so a section's own requests go out
 * first: `requestIdleCallback` where it exists (bounded by the same 1.5 s the
 * fallback uses), otherwise `setTimeout(…, 1500)`. Returns a cancel function.
 */
export const IDLE_FALLBACK_MS = 1500;

export function runWhenIdle(task: () => void): () => void {
  if (typeof window === "undefined") {
    task();
    return () => {};
  }
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (id: number) => void;
  };
  if (typeof w.requestIdleCallback === "function") {
    const id = w.requestIdleCallback(task, { timeout: IDLE_FALLBACK_MS });
    return () => w.cancelIdleCallback?.(id);
  }
  const id = window.setTimeout(task, IDLE_FALLBACK_MS);
  return () => window.clearTimeout(id);
}
