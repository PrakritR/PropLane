/**
 * No-op-write guards. The production database runs on a tiny Disk IO budget, and the churn
 * that exhausted it was UPDATEs that rewrote a row with the value it already held (a whole
 * `property_data` blob per channel sync, a connection row per poll). Every periodic writer
 * compares first through these helpers and writes only when something actually changed.
 */

/** JSON with object keys sorted, so two structurally equal values serialize identically. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) sorted[k] = (v as Record<string, unknown>)[k];
      return sorted;
    }
    return v;
  }) ?? "undefined";
}

/** Structural equality ignoring object key order (undefined-valued keys are ignored, as JSON does). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return stableStringify(a) === stableStringify(b);
}

/** Two lists hold the same elements, in any order (a re-merge may reorder, never change, a set). */
export function sameUnorderedList(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  const left = a.map(stableStringify).sort();
  const right = b.map(stableStringify).sort();
  return left.every((item, index) => item === right[index]);
}

/** A "last synced / last fetched" stamp is refreshed at most this often when nothing else changed. */
export const SYNC_STAMP_MIN_INTERVAL_MS = 15 * 60_000;

/**
 * Whether a bookkeeping timestamp needs rewriting: always when the payload changed or the stamp
 * is missing/unparseable, otherwise only once it is older than `minIntervalMs`.
 */
export function shouldRestamp(input: {
  lastStampIso: string | null | undefined;
  now: Date;
  changed: boolean;
  minIntervalMs?: number;
}): boolean {
  if (input.changed) return true;
  const last = input.lastStampIso ? Date.parse(input.lastStampIso) : NaN;
  if (!Number.isFinite(last)) return true;
  return input.now.getTime() - last >= (input.minIntervalMs ?? SYNC_STAMP_MIN_INTERVAL_MS);
}
