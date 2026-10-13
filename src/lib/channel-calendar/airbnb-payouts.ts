import type { DemoManagerPaymentLedgerRow } from "@/data/demo-portal";
import type { AirbnbPayoutRow } from "@/lib/channel-calendar/client";
import { bookingEntryGuestLabel } from "@/lib/channel-calendar/booking-guest-label";
import { addDaysToDateKey, bookingEntryKey, formatBookingStayRangeShort } from "@/lib/channel-calendar/bookings-ui";
import { isHostBlockSummary } from "@/lib/channel-calendar/host-block";
import { airbnbBookingEntries } from "@/lib/channel-calendar/property-bookings";
import type { ManagerChannelBookingProperty } from "@/lib/channel-calendar/types";
import { formatCentsAsUsd } from "@/lib/money-label-totals";

export const AIRBNB_PAYOUT_ROW_PREFIX = "airbnb:";
export const AIRBNB_PAYOUT_CHARGE_KIND = "airbnb_payout";

export function isAirbnbPayoutLedgerRow(row: Pick<DemoManagerPaymentLedgerRow, "chargeKind">): boolean {
  return row.chargeKind === AIRBNB_PAYOUT_CHARGE_KIND;
}

/** Every Airbnb stay that has a payout amount, as a payout row. Host blocks and stays without a payout never project. */
export function airbnbPayoutRowsFromBookings(properties: ManagerChannelBookingProperty[]): AirbnbPayoutRow[] {
  const out: AirbnbPayoutRow[] = [];
  for (const entry of airbnbBookingEntries(properties)) {
    if (entry.source !== "airbnb" || isHostBlockSummary(entry.summary)) continue;
    if (typeof entry.payoutCents !== "number" || entry.payoutCents <= 0) continue;
    if (!entry.connectionId || !entry.sourceUid) continue;
    out.push({
      id: `${AIRBNB_PAYOUT_ROW_PREFIX}${entry.connectionId}:${entry.sourceUid}`,
      connectionId: entry.connectionId,
      sourceUid: entry.sourceUid,
      propertyId: entry.propertyId,
      propertyLabel: entry.propertyLabel,
      roomLabel: entry.roomLabel,
      guestLabel: bookingEntryGuestLabel(entry),
      start: entry.start,
      end: entry.end,
      payoutCents: entry.payoutCents,
      paidAt: entry.paidAt ?? null,
      bookingKey: bookingEntryKey(entry),
    });
  }
  return out;
}

function ymdLabel(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  if (!y || !m || !d) return key;
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** The day the payout is expected: the morning after check-out (`end` is the last night). */
export function airbnbPayoutDueKey(row: Pick<AirbnbPayoutRow, "end">): string {
  return addDaysToDateKey(row.end, 2);
}

/** "Airbnb · Juan" - the guest's name, or the reservation code when no name was typed. */
export function airbnbPayoutTitle(row: Pick<AirbnbPayoutRow, "guestLabel">): string {
  const label = row.guestLabel.replace(/^Airbnb guest · /, "").trim();
  return `Airbnb · ${label || "Guest"}`;
}

/** "Payout · 4709a 8th Ave · Room 4 · Oct 7 – Oct 15" */
export function airbnbPayoutPlaceLine(row: AirbnbPayoutRow): string {
  const range = formatBookingStayRangeShort(row.start, row.end).replace(" → ", " – ");
  return ["Payout", row.propertyLabel, row.roomLabel, range].filter(Boolean).join(" · ");
}

/** "Paid Oct 16, 2026" or "Due Oct 16, 2026". */
export function airbnbPayoutFact(row: AirbnbPayoutRow): string {
  if (row.paidAt) {
    const d = new Date(row.paidAt);
    return `Paid ${Number.isNaN(d.getTime()) ? row.paidAt : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}`;
  }
  return `Due ${ymdLabel(airbnbPayoutDueKey(row))}`;
}

/** The Incoming payments row for one payout. Never a household charge: it has no `householdChargeId`. */
export function airbnbPayoutLedgerRow(row: AirbnbPayoutRow): DemoManagerPaymentLedgerRow {
  const paid = Boolean(row.paidAt);
  const amount = formatCentsAsUsd(row.payoutCents);
  const dueKey = airbnbPayoutDueKey(row);
  const [y, m, d] = dueKey.split("-").map(Number);
  return {
    id: row.id,
    propertyId: row.propertyId,
    propertyName: row.propertyLabel,
    roomNumber: row.roomLabel,
    chargeKind: AIRBNB_PAYOUT_CHARGE_KIND,
    residentName: airbnbPayoutTitle(row),
    chargeTitle: "Airbnb payout",
    lineAmount: amount,
    amountPaid: paid ? amount : "$0.00",
    balanceDue: paid ? "$0.00" : amount,
    dueDate: airbnbPayoutFact(row),
    dueDateSortMs: y && m && d ? new Date(y, m - 1, d).getTime() : null,
    bucket: paid ? "paid" : "pending",
    statusLabel: paid ? "Paid" : "Pending",
    notes: "",
  };
}
