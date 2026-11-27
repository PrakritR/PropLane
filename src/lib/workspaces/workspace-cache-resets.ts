/**
 * Memory mirrors that a workspace switch must drop. Each client store registers its own reset when its module loads,
 * so a store that never loaded (and so holds nothing) is never imported just to be cleared.
 */
const resets = new Set<() => void>();

export function registerWorkspaceCacheReset(reset: () => void): void {
  resets.add(reset);
}

/** Run every registered reset; one that throws never stops the others. */
export function runWorkspaceCacheResets(): void {
  for (const reset of resets) {
    try {
      reset();
    } catch {
      /* the other resets still run */
    }
  }
}
