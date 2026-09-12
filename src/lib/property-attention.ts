/**
 * What a property needs from its manager, read off the records that already
 * exist — so the Properties list can answer "which one needs me" instead of
 * only "which ones do I have".
 *
 * Three signals, each from the application rows the portal already syncs:
 *
 * - **Open** — rooms nobody holds. By-the-room: rooms minus approved
 *   applications placed on the property. Whole place: one unit, held or not.
 * - **Waiting** — pending applications on the property, which is the thing a
 *   manager loses money by leaving alone.
 * - **Ending soon** — an approved resident whose recorded move-out date is
 *   within the next 45 days, so the room will be open before long.
 *
 * Everything here is descriptive. Nothing enforces occupancy from it — the
 * database guard on placement reads `occupancyCapacity`, not this — so an
 * imperfect count can never let an extra resident in; it can only mislabel a
 * row, which is the failure mode this is allowed to have.
 */

import type { DemoApplicantRow } from "@/data/demo-portal";
import type { AdminPropertyRow } from "@/lib/demo-admin-property-inventory";

export type PropertyAttention = {
  /** Rooms (or the one unit) with nobody placed. */
  open: number;
  /** Pending applications waiting on the manager. */
  waiting: number;
  /** The soonest recorded move-out inside the window, if any. */
  endingSoon: { name: string; date: string } | null;
  /** Rooms (or the one unit) the listing offers, for "2 of 3 filled". */
  units: number;
  /** Higher needs the manager sooner. Zero means nothing to do here. */
  score: number;
};

const ENDING_SOON_DAYS = 45;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Every id an application row may name a property by. */
function propertyIds(row: Pick<AdminPropertyRow, "adminRefId" | "listingId">): Set<string> {
  return new Set([row.adminRefId, row.listingId].map((s) => (s ?? "").trim()).filter(Boolean));
}

function appPropertyId(app: Pick<DemoApplicantRow, "assignedPropertyId" | "propertyId">): string {
  return (app.assignedPropertyId ?? app.propertyId ?? "").trim();
}

function isActive(app: Pick<DemoApplicantRow, "withdrawnAt">): boolean {
  return !app.withdrawnAt;
}

function moveOutOf(app: Pick<DemoApplicantRow, "manualResidentDetails">): string {
  return (app.manualResidentDetails?.moveOutDate ?? "").trim();
}

export function propertyAttention(
  row: Pick<AdminPropertyRow, "adminRefId" | "listingId" | "submission">,
  applications: readonly DemoApplicantRow[],
  today: Date = new Date(),
): PropertyAttention {
  const ids = propertyIds(row);
  const mine = applications.filter((a) => isActive(a) && ids.has(appPropertyId(a)));

  const byRoom = row.submission?.listingPlaceCategoryId !== "entire_home";
  const rooms = row.submission?.rooms?.length ?? 0;
  const units = byRoom ? Math.max(rooms, 1) : 1;

  const approved = mine.filter((a) => a.bucket === "approved");
  const waiting = mine.filter((a) => a.bucket === "pending").length;

  // A room holds one resident unless the room says otherwise; a placement with
  // no room named still fills one slot. Count placements, capped at capacity.
  const filled = Math.min(units, approved.length);
  const open = Math.max(0, units - filled);

  const horizon = today.getTime() + ENDING_SOON_DAYS * DAY_MS;
  const ending = approved
    .map((a) => ({ name: a.name?.trim() || "A resident", date: moveOutOf(a) }))
    .filter((e) => e.date)
    .map((e) => ({ ...e, t: new Date(`${e.date}T12:00:00`).getTime() }))
    .filter((e) => Number.isFinite(e.t) && e.t >= today.getTime() - DAY_MS && e.t <= horizon)
    .sort((a, b) => a.t - b.t)[0];
  const endingSoon = ending ? { name: ending.name, date: ending.date } : null;

  // Waiting outranks open: an application is money already at the door.
  const score = waiting * 3 + open * 2 + (endingSoon ? 1 : 0);
  return { open, waiting, endingSoon, units, score };
}

function shortDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** The parts of the attention line, each with a tone the row can colour. */
export function propertyAttentionParts(a: PropertyAttention): { text: string; tone: "warning" | "info" | "neutral" }[] {
  const parts: { text: string; tone: "warning" | "info" | "neutral" }[] = [];
  if (a.waiting > 0) parts.push({ text: `${a.waiting} ${a.waiting === 1 ? "application" : "applications"} waiting`, tone: "warning" });
  if (a.open > 0) parts.push({ text: a.units > 1 ? `${a.open} of ${a.units} open` : "Open", tone: "info" });
  if (a.endingSoon) parts.push({ text: `Lease ends ${shortDate(a.endingSoon.date)}`, tone: "neutral" });
  return parts;
}

/** Totals across a list, for the strip above it. */
export function summarizeAttention(items: readonly PropertyAttention[]): {
  open: number;
  waiting: number;
  ending: number;
} {
  return items.reduce(
    (t, a) => ({ open: t.open + a.open, waiting: t.waiting + a.waiting, ending: t.ending + (a.endingSoon ? 1 : 0) }),
    { open: 0, waiting: 0, ending: 0 },
  );
}
