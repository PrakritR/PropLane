import { migrationDate } from "@/lib/sales-migration/model";

export type UtilityPlacement = { id: string; roomId: string; start: string; end: string | null };
export type UtilityAllocationRule = "occupant_days" | "occupied_room_days";
const day = (value: string) => Date.parse(`${migrationDate.parse(value)}T00:00:00Z`) / 86_400_000;

/** Inclusive residency dates match shared-room capacity; largest remainders preserve every cent. */
export function allocateUtilityBill(input: { amountCents: number; start: string; end: string; rule: UtilityAllocationRule; placements: UtilityPlacement[]; excludeIds?: string[] }) {
  const start = day(input.start), end = day(input.end);
  if (end < start || end - start > 366) throw new Error("Bill period must be between 1 and 367 days");
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0 || input.amountCents > 1_000_000_000) throw new Error("Allocation must be positive integer cents");
  if (new Set(input.placements.map(p => p.id)).size !== input.placements.length) throw new Error("Duplicate placement");
  const exclusions = new Set(input.excludeIds ?? []);
  if ([...exclusions].some(id => !input.placements.some(p => p.id === id))) throw new Error("Unknown excluded placement");
  const rows = input.placements.filter(p => !exclusions.has(p.id)).map(p => ({ ...p, startDay: day(p.start), endDay: p.end ? day(p.end) : Infinity, weight: 0, days: 0 }));
  if (rows.some(p => p.endDay < p.startDay || !p.roomId)) throw new Error("Invalid placement period or room");
  for (let d = start; d <= end; d++) {
    const present = rows.filter(p => p.startDay <= d && p.endDay >= d);
    const perRoom = new Map<string, number>();
    for (const p of present) perRoom.set(p.roomId, (perRoom.get(p.roomId) ?? 0) + 1);
    for (const p of present) { p.days++; p.weight += input.rule === "occupant_days" ? 1 : 1 / perRoom.get(p.roomId)!; }
  }
  const total = rows.reduce((s, p) => s + p.weight, 0);
  if (!total) throw new Error("No eligible occupancy in the service period");
  const allocated = rows.filter(p => p.weight > 0).map(p => {
    const exact = input.amountCents * p.weight / total;
    return { applicationId: p.id, roomId: p.roomId, occupiedDays: p.days, amountCents: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let remaining = input.amountCents - allocated.reduce((s, p) => s + p.amountCents, 0);
  const ranked = [...allocated].sort((a, b) => b.remainder - a.remainder || a.applicationId.localeCompare(b.applicationId));
  for (const row of ranked) { if (!remaining) break; row.amountCents++; remaining--; }
  if (remaining !== 0) throw new Error("Allocation rounding failed to reconcile");
  return allocated.map(({ applicationId, roomId, occupiedDays, amountCents }) => ({ applicationId, roomId, occupiedDays, amountCents })).sort((a, b) => a.applicationId.localeCompare(b.applicationId));
}
