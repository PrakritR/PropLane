import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";

/**
 * C2-BK2 / CX-ST1 — notes and stay details on a stay whose dates belong to
 * another record.
 *
 * A signed lease's dates, room and rent belong to the Lease; an approved
 * application's belong to the Application; a channel reservation belongs to the
 * channel. What a manager may still write on the Bookings side is the
 * housekeeping they keep about the stay (notes, linen, baggage, early check-in,
 * late check-out). That lives in its own record per lease/application, written
 * only through `/api/portal/bookings/stay-meta`, which re-derives ownership of
 * the lease/application from the session. Channel feed stays are read-only
 * (C2-AB6) and never reach this path.
 */

export type StayMetaKind = "lease" | "application";
export type StayMetaDetails = NonNullable<PropertyBookingEntry["stayDetails"]>;
export type StayMeta = { kind: StayMetaKind; refId: string; notes: string; stayDetails: StayMetaDetails };

export const STAY_META_CHANGED = "axis:booking-stay-meta-changed";
export const STAY_META_NOTES_MAX = 2000;
const DETAIL_KEYS = ["linen", "baggage", "earlyCheckIn", "lateCheckOut"] as const;
const DETAIL_VALUE_MAX = 60;
const REF_ID_MAX = 200;

/** The lease/application a stay's metadata hangs off, or null for a stay that has none (blocks, channel feeds). */
export function stayMetaRefOf(
  entry: Pick<PropertyBookingEntry, "source" | "leaseId" | "applicationId" | "bookingStatus">,
): { kind: StayMetaKind; refId: string } | null {
  if (entry.bookingStatus === "cancelled") return null;
  if (entry.source === "proplane" && entry.leaseId?.trim()) return { kind: "lease", refId: entry.leaseId.trim() };
  if (entry.source === "hold" && entry.applicationId?.trim()) return { kind: "application", refId: entry.applicationId.trim() };
  return null;
}

export function stayMetaKey(kind: StayMetaKind, refId: string): string {
  return `${kind}:${refId.trim()}`;
}

/**
 * Validates a client payload. `source` is deliberately not accepted: where a
 * signed or application stay came from is a fact about the lease/application,
 * not something to overwrite here.
 */
export function normalizeStayMetaInput(raw: unknown): StayMeta | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.kind !== "lease" && o.kind !== "application") return null;
  const refId = typeof o.refId === "string" ? o.refId.trim() : "";
  if (!refId || refId.length > REF_ID_MAX) return null;
  const notes = typeof o.notes === "string" ? o.notes.trim() : "";
  if (notes.length > STAY_META_NOTES_MAX) return null;
  const stayDetails: StayMetaDetails = {};
  const rawDetails = o.stayDetails;
  if (rawDetails && typeof rawDetails === "object" && !Array.isArray(rawDetails)) {
    const values = rawDetails as Record<string, unknown>;
    for (const key of DETAIL_KEYS) {
      const value = values[key];
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (trimmed.length > DETAIL_VALUE_MAX) return null;
      if (trimmed) stayDetails[key] = trimmed;
    }
  }
  return { kind: o.kind, refId, notes, stayDetails };
}

/** Lays saved notes/details over the stays they belong to; any other stay passes through untouched. */
export function applyStayMeta(entries: readonly PropertyBookingEntry[], metas: readonly StayMeta[]): PropertyBookingEntry[] {
  if (metas.length === 0) return [...entries];
  const byKey = new Map(metas.map((meta) => [stayMetaKey(meta.kind, meta.refId), meta]));
  return entries.map((entry) => {
    const ref = stayMetaRefOf(entry);
    const meta = ref ? byKey.get(stayMetaKey(ref.kind, ref.refId)) : undefined;
    if (!meta) return entry;
    const details = { ...(entry.stayDetails ?? {}), ...meta.stayDetails };
    return {
      ...entry,
      ...(meta.notes ? { reason: meta.notes } : {}),
      ...(Object.keys(details).length ? { stayDetails: details } : {}),
    };
  });
}
