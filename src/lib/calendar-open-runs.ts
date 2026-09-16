/**
 * Merge per-kind open slot sets for one calendar day into contiguous runs, so
 * a calendar grid can render one bar per stretch of identical availability
 * ("Tours · Services" for 9-10, "Services" for 10-11) rather than
 * one cell per 30-minute slot.
 */
import { AVAILABILITY_KIND_LABELS, AVAILABILITY_KINDS, type AvailabilityKind } from "@/lib/manager-availability-kinds";

export type OpenRun = { startSlot: number; endSlotExclusive: number; kinds: AvailabilityKind[] };

function orderedKinds(open: Set<AvailabilityKind>): AvailabilityKind[] {
  return AVAILABILITY_KINDS.filter((kind) => open.has(kind));
}

function sameKinds(a: readonly AvailabilityKind[], b: readonly AvailabilityKind[]): boolean {
  return a.length === b.length && a.every((kind, i) => kind === b[i]);
}

/** One day's worth of open runs, one per kind-set change. Sorted by `startSlot`. */
export function mergeOpenRuns(slotsByKind: Partial<Record<AvailabilityKind, Iterable<number>>>): OpenRun[] {
  const kindsBySlot = new Map<number, Set<AvailabilityKind>>();
  for (const kind of AVAILABILITY_KINDS) {
    const slots = slotsByKind[kind];
    if (!slots) continue;
    for (const slot of slots) {
      if (!Number.isFinite(slot) || slot < 0 || slot >= 48) continue;
      const open = kindsBySlot.get(slot) ?? new Set<AvailabilityKind>();
      open.add(kind);
      kindsBySlot.set(slot, open);
    }
  }
  if (kindsBySlot.size === 0) return [];

  const sortedSlots = [...kindsBySlot.keys()].sort((a, b) => a - b);
  const runs: OpenRun[] = [];
  let runStart = sortedSlots[0]!;
  let runEnd = runStart + 1;
  let runKinds = orderedKinds(kindsBySlot.get(runStart)!);

  for (let i = 1; i < sortedSlots.length; i += 1) {
    const slot = sortedSlots[i]!;
    const kinds = orderedKinds(kindsBySlot.get(slot)!);
    if (slot === runEnd && sameKinds(kinds, runKinds)) {
      runEnd = slot + 1;
      continue;
    }
    runs.push({ startSlot: runStart, endSlotExclusive: runEnd, kinds: runKinds });
    runStart = slot;
    runEnd = slot + 1;
    runKinds = kinds;
  }
  runs.push({ startSlot: runStart, endSlotExclusive: runEnd, kinds: runKinds });
  return runs;
}

/**
 * The block label reads by its category: a tours-only block is "Tours", a
 * mixed block is "Tours · Services". (Previously tours-only rendered the bare
 * word "Open", which read as "not yet configured" — see PLAN-0916-0041.)
 */
export function formatOpenRunKindsLabel(kinds: AvailabilityKind[]): string {
  if (kinds.length === 0) return "Open";
  return kinds.map((kind) => AVAILABILITY_KIND_LABELS[kind]).join(" · ");
}
