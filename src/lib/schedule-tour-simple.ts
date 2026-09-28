/**
 * The simplified "Schedule tour" modal's pure helpers (N084).
 *
 * Kept out of the component file so both are trivial to unit test:
 * - `fetchOpenTourSlotsForProperty` is a thin client wrapper around the SAME
 *   public route the resident/guest booking grid and every tour tool read —
 *   `GET /api/public/property-tour-availability`, itself a caller of
 *   `listOpenTourSlots` (`src/lib/tour-availability.server.ts`). Nothing here
 *   invents a slot concept; a slot is only ever one this route returned.
 * - `buildScheduleTourSimpleForm` builds the exact same `AddPersonForm` shape
 *   the old 4-step wizard's Contact/Home/Tour steps would have produced for
 *   equivalent field values, so `buildProspectRow` / `commitProspect`
 *   (`resident-wizard/state.ts` / `resident-wizard/commit.ts`) — the same
 *   booking path the old wizard called — see an identical payload. See
 *   `tests/unit/schedule-tour-simple.test.ts`.
 */

import { emptyAddPersonForm, type AddPersonForm } from "@/components/portal/resident-wizard/state";
import type { PropertyManagerEntry } from "@/lib/demo-admin-scheduling";

export type SlotHosts = Record<string, PropertyManagerEntry[]>;

/** The `dateStr` half of a `"YYYY-MM-DD:idx"` slot key. */
export function slotKeyDateStr(slotKey: string): string {
  return slotKey.split(":")[0] ?? "";
}

/** The half-hour-of-day index (0–47) half of a `"YYYY-MM-DD:idx"` slot key. */
export function slotKeyIndex(slotKey: string): number {
  return Number.parseInt(slotKey.split(":")[1] ?? "", 10);
}

/** `"YYYY-MM-DD:idx"` → the `tourDate` / `tourStart` (24h `HH:MM`) an old-wizard-shaped form would carry. */
export function slotKeyToTourFields(slotKey: string): { tourDate: string; tourStart: string } | null {
  const date = slotKeyDateStr(slotKey);
  const idx = slotKeyIndex(slotKey);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(idx) || idx < 0 || idx >= 48) return null;
  const minutes = idx * 30;
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return { tourDate: date, tourStart: `${hh}:${mm}` };
}

/** Every open slot key for one calendar date, earliest first — same "open" the public grid draws. */
export function openSlotKeysForDate(slotHosts: SlotHosts, dateStr: string): string[] {
  return Object.entries(slotHosts)
    .filter(([key, hosts]) => hosts.length > 0 && slotKeyDateStr(key) === dateStr)
    .map(([key]) => key)
    .sort((a, b) => slotKeyIndex(a) - slotKeyIndex(b));
}

/** Every calendar date (`YYYY-MM-DD`) that has at least one open slot. */
export function openTourDates(slotHosts: SlotHosts): Set<string> {
  const out = new Set<string>();
  for (const [key, hosts] of Object.entries(slotHosts)) {
    if (hosts.length > 0) out.add(slotKeyDateStr(key));
  }
  return out;
}

export type FetchOpenTourSlotsResult =
  | { ok: true; slotHosts: SlotHosts }
  | { ok: false; error: string };

/**
 * The offered set for one property — the client half of `listOpenTourSlots`.
 * This calls the exact public route the guest tour-booking flow and every
 * agent tour tool read from, so nothing here can offer a time that route
 * would not.
 */
export async function fetchOpenTourSlotsForProperty(property: {
  id: string;
  buildingName?: string | null;
  address?: string | null;
}): Promise<FetchOpenTourSlotsResult> {
  const propertyId = property.id.trim();
  if (!propertyId) return { ok: true, slotHosts: {} };
  const params = new URLSearchParams({ propertyId });
  if (property.buildingName) params.set("buildingName", property.buildingName);
  if (property.address) params.set("address", property.address);
  try {
    const res = await fetch(`/api/public/property-tour-availability?${params.toString()}`);
    const body = (await res.json().catch(() => ({}))) as { slotHosts?: SlotHosts; error?: string };
    if (!res.ok) return { ok: false, error: body.error ?? "Could not load open tour times." };
    return { ok: true, slotHosts: body.slotHosts ?? {} };
  } catch {
    return { ok: false, error: "Could not load open tour times." };
  }
}

export type ScheduleTourSimpleInput = {
  name: string;
  email: string;
  phone: string;
  propertyId: string;
  roomId: string;
  bundleId: string;
  tourFormat: AddPersonForm["tourFormat"];
  /** The chosen `"YYYY-MM-DD:idx"` open slot, or `null` when none is picked yet. */
  slotKey: string | null;
  tourNotes: string;
};

/**
 * Build the prospect `AddPersonForm` this modal's inputs describe.
 *
 * Deliberately built the same way the old wizard built one: start from
 * `emptyAddPersonForm("prospect")` (so every untouched field — duration,
 * preferred contact, message channels — keeps the same default the old
 * Contact/Tour steps left it at) and patch only the fields this simplified
 * screen actually collects. For the same inputs this is byte-identical to
 * what `ContactStep` + `HomeStep` + `TourStep` would have produced, so
 * `buildProspectRow` / `commitProspect` see the same payload either way.
 */
export function buildScheduleTourSimpleForm(input: ScheduleTourSimpleInput): AddPersonForm {
  const base = emptyAddPersonForm("prospect");
  const slot = input.tourFormat !== "none" && input.slotKey ? slotKeyToTourFields(input.slotKey) : null;
  return {
    ...base,
    name: input.name,
    email: input.email,
    phone: input.phone,
    propertyId: input.propertyId,
    roomId: input.roomId,
    bundleId: input.bundleId,
    tourFormat: input.tourFormat,
    tourDate: slot?.tourDate ?? "",
    tourStart: slot?.tourStart ?? "",
    tourNotes: input.tourNotes,
  };
}
