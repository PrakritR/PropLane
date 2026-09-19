/** Next rail index Continue should land on — off-path extras are skipped. */
export function nextOnPathIndex(steps: readonly { offPath?: boolean }[], from: number): number | null {
  for (let i = from + 1; i < steps.length; i++) {
    if (!steps[i]!.offPath) return i;
  }
  return null;
}

export function prevOnPathIndex(steps: readonly { offPath?: boolean }[], from: number): number | null {
  for (let i = from - 1; i >= 0; i--) {
    if (!steps[i]!.offPath) return i;
  }
  return null;
}
