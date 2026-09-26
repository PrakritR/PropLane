/**
 * Room rent by how many residents live in it (Specs Part 1).
 *
 * Everyone in a room pays the same amount. What changes is the arrangement:
 * Private (1) / Shared by 2 / Shared by 3 / Shared by 4. A larger set may be
 * "Same as" a smaller one. Legacy rooms with no `occupancyPrices` keep one
 * `monthlyRent` for every count.
 */

import { normalizeRoomOccupancyCapacity } from "@/lib/rental-application/room-occupancy";

export type RoomOccupancyPrice = {
  /** 1-based head count this row prices. */
  count: number;
  /** Copy figures from this smaller count. Absent or 0 means own figures. */
  sameAs?: number;
  monthlyRent?: number;
  utilitiesEstimate?: string;
  securityDeposit?: string;
  pricingMode?: "fixed" | "flexible";
  prorateMethod?: "auto" | "daily_rate";
  dailyRentRate?: number;
  dailyUtilitiesRate?: number;
};

export type ArrangementRoomLike = {
  monthlyRent?: number | null;
  utilitiesEstimate?: string | null;
  securityDeposit?: string | null;
  occupancyCapacity?: number | null;
  offeredResidentCounts?: readonly number[] | null;
  occupancyPrices?: readonly RoomOccupancyPrice[] | null;
};

export function arrangementLabel(count: number): string {
  if (count <= 1) return "Private room";
  return `Shared by ${count}`;
}

/** Absent offered list means every count from 1 through capacity. Never empty. */
export function offeredResidentCountsFor(room: ArrangementRoomLike | null | undefined): number[] {
  const capacity = normalizeRoomOccupancyCapacity(room?.occupancyCapacity);
  const raw = room?.offeredResidentCounts;
  if (!raw || raw.length === 0) {
    return Array.from({ length: capacity }, (_, i) => i + 1);
  }
  const set = new Set<number>();
  for (const n of raw) {
    if (Number.isInteger(n) && n >= 1 && n <= capacity) set.add(n);
  }
  if (!set.has(1) && capacity >= 1) set.add(1);
  const out = [...set].sort((a, b) => a - b);
  return out.length ? out : [1];
}

function positiveRent(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function normalizeOccupancyPrices(
  raw: unknown,
  capacity: number,
): RoomOccupancyPrice[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const cap = Math.max(1, Math.min(20, capacity || 1));
  const byCount = new Map<number, RoomOccupancyPrice>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const count = Number(row.count);
    if (!Number.isInteger(count) || count < 1 || count > cap) continue;
    const sameAsRaw = Number(row.sameAs);
    const sameAs =
      Number.isInteger(sameAsRaw) && sameAsRaw >= 1 && sameAsRaw < count ? sameAsRaw : undefined;
    const rent = positiveRent(row.monthlyRent);
    const next: RoomOccupancyPrice = { count };
    if (sameAs) next.sameAs = sameAs;
    if (rent !== undefined) next.monthlyRent = rent;
    if (typeof row.utilitiesEstimate === "string" && row.utilitiesEstimate.trim()) {
      next.utilitiesEstimate = row.utilitiesEstimate.trim();
    }
    if (typeof row.securityDeposit === "string" && row.securityDeposit.trim()) {
      next.securityDeposit = row.securityDeposit.trim();
    }
    if (row.pricingMode === "fixed" || row.pricingMode === "flexible") next.pricingMode = row.pricingMode;
    if (row.prorateMethod === "auto" || row.prorateMethod === "daily_rate") next.prorateMethod = row.prorateMethod;
    const dailyRent = positiveRent(row.dailyRentRate);
    if (dailyRent !== undefined) next.dailyRentRate = dailyRent;
    const dailyUtil = positiveRent(row.dailyUtilitiesRate);
    if (dailyUtil !== undefined) next.dailyUtilitiesRate = dailyUtil;
    byCount.set(count, next);
  }
  if (byCount.size === 0) return undefined;
  return [...byCount.values()].sort((a, b) => a.count - b.count);
}

export type ResolvedArrangementPrice = {
  count: number;
  monthlyRent: number;
  utilitiesEstimate: string;
  securityDeposit: string;
  sameAs?: number;
};

/** Follow `sameAs` (cycle-safe) and fall back to the room's own figures. */
export function roomPriceForResidentCount(
  room: ArrangementRoomLike | null | undefined,
  count: number,
): ResolvedArrangementPrice {
  const capacity = normalizeRoomOccupancyCapacity(room?.occupancyCapacity);
  const clamped = Math.max(1, Math.min(capacity, Math.floor(Number(count) || 1)));
  const baseRent = positiveRent(room?.monthlyRent) ?? 0;
  const baseUtil = String(room?.utilitiesEstimate ?? "").trim();
  const baseDep = String(room?.securityDeposit ?? "").trim();
  const rows = room?.occupancyPrices ?? [];
  const seen = new Set<number>();
  let cursor = clamped;
  for (let hop = 0; hop < 8; hop += 1) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const row = rows.find((r) => r.count === cursor);
    if (!row) break;
    if (row.sameAs && row.sameAs < cursor) {
      cursor = row.sameAs;
      continue;
    }
    return {
      count: clamped,
      monthlyRent: positiveRent(row.monthlyRent) ?? baseRent,
      utilitiesEstimate: row.utilitiesEstimate?.trim() || baseUtil,
      securityDeposit: row.securityDeposit?.trim() || baseDep,
      sameAs: rows.find((r) => r.count === clamped)?.sameAs,
    };
  }
  return {
    count: clamped,
    monthlyRent: baseRent,
    utilitiesEstimate: baseUtil,
    securityDeposit: baseDep,
  };
}

/** Counts a new applicant may pick, given how many already live in the room. */
export function roomSharingOptions(
  room: ArrangementRoomLike | null | undefined,
  livingNow = 0,
): number[] {
  const living = Math.max(0, Math.floor(livingNow));
  return offeredResidentCountsFor(room).filter((count) => count > living);
}

export function arrangementSummaryLine(room: ArrangementRoomLike | null | undefined): string | null {
  const capacity = normalizeRoomOccupancyCapacity(room?.occupancyCapacity);
  if (capacity < 2) return null;
  const offered = offeredResidentCountsFor(room);
  if (!room?.occupancyPrices?.length) {
    const rent = positiveRent(room?.monthlyRent);
    return rent ? `${capacity} residents · $${rent.toLocaleString("en-US")} each` : `${capacity} residents · rent per resident`;
  }
  const parts = offered.map((count) => {
    const price = roomPriceForResidentCount(room, count);
    const money = price.monthlyRent > 0 ? `$${price.monthlyRent.toLocaleString("en-US")}` : "—";
    const label = count === 1 ? "Private" : `Shared by ${count}`;
    return `${label} ${money}${count > 1 ? " each" : ""}`;
  });
  return parts.join(" · ");
}
