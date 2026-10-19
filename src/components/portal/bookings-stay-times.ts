import { bookingCheckout } from "@/lib/channel-calendar/bookings-calendar-view";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import {
  DEFAULT_PROPERTY_STAY_TIMES,
  STAY_ADD_ON_KINDS,
  formatAddOnPrice,
  formatStayMoment,
  formatStayTime,
  resolveStayTimes,
  stayAddOnLabel,
  type PropertyStayTimes,
  type StayAddOnKind,
  type StayAddOns,
  type TimedStay,
} from "@/lib/bookings/stay-times";

/**
 * Pure helpers the Bookings calendar uses to read a stay's exact times (bookings-times-1018). Nothing here touches
 * React or the listing store: the property defaults are passed in, so the layout, the bar, the sheet and the record
 * page all answer the same question the same way. An entry that carries no time of its own reads the property's.
 */

/** The time fields Contract A stamps on an entry; typed here so the calendar works before and after they land. */
export type TimedBookingEntry = PropertyBookingEntry & {
  checkInTime?: string;
  checkOutTime?: string;
  addOns?: StayAddOns;
  estimatedArrival?: string;
};

export type EntryStayTimes = { checkInTime: string; checkOutTime: string };

/** Open-ended stays (a lease with no end) check out on a date far past any range. */
const FAR_CHECKOUT = "9999-12-31";

export function entryStayTimes(entry: PropertyBookingEntry, property: PropertyStayTimes = DEFAULT_PROPERTY_STAY_TIMES): EntryStayTimes {
  const timed = entry as TimedBookingEntry;
  return resolveStayTimes(
    {
      checkInTime: timed.checkInTime,
      checkOutTime: timed.checkOutTime,
      legacyEarlyCheckIn: entry.stayDetails?.earlyCheckIn,
      legacyLateCheckOut: entry.stayDetails?.lateCheckOut,
    },
    property,
  );
}

/** The entry as a `TimedStay` (checkout is the exclusive checkout DATE). */
export function entryTimedStay(entry: PropertyBookingEntry, id: string, property: PropertyStayTimes = DEFAULT_PROPERTY_STAY_TIMES): TimedStay {
  const times = entryStayTimes(entry, property);
  return { id, checkIn: entry.start, checkOut: entry.openEnded ? FAR_CHECKOUT : bookingCheckout(entry)!, ...times };
}

export type EntryMoments = EntryStayTimes & {
  /** "Oct 16, 3:00 pm". */
  inLabel: string;
  /** "Oct 19, 11:00 am"; null for an open-ended stay. */
  outLabel: string | null;
};

export function entryMoments(entry: PropertyBookingEntry, times: EntryStayTimes = entryStayTimes(entry)): EntryMoments {
  const checkout = entry.openEnded ? null : bookingCheckout(entry);
  return {
    ...times,
    inLabel: formatStayMoment(entry.start, times.checkInTime),
    outLabel: checkout ? formatStayMoment(checkout, times.checkOutTime) : null,
  };
}

/** `Brandi · out Oct 19, 11:00 am` - the title line of the popover and the phone sheet. */
export function stayTitleLine(name: string, moments: EntryMoments): string {
  return moments.outLabel ? `${name} · out ${moments.outLabel}` : name;
}

export type PaidAddOn = { kind: StayAddOnKind; time: string; priceCents: number; label: string };

/** The add-ons that were paid and applied to this stay (early check-in, late checkout). */
export function paidAddOns(entry: PropertyBookingEntry): PaidAddOn[] {
  const addOns = (entry as TimedBookingEntry).addOns;
  if (!addOns) return [];
  const out: PaidAddOn[] = [];
  for (const kind of STAY_ADD_ON_KINDS) {
    const record = addOns[kind];
    if (record?.status !== "paid") continue;
    out.push({ kind, time: record.time, priceCents: record.priceCents, label: `${stayAddOnLabel(kind)} ${formatStayTime(record.time)}` });
  }
  return out;
}

/** A paid add-on as a label / value fact row: "Early check-in" | "12:00 pm · $25 paid". */
export function paidAddOnRows(entry: PropertyBookingEntry): { label: string; value: string }[] {
  return paidAddOns(entry).map(add => ({ label: stayAddOnLabel(add.kind), value: `${formatStayTime(add.time)} · ${formatAddOnPrice(add.priceCents)} paid` }));
}

/** The clock glyph's accessible name, "Early check-in 12:00 pm" (both, joined, when both were paid); null when none. */
export function paidAddOnGlyphLabel(entry: PropertyBookingEntry): string | null {
  const paid = paidAddOns(entry);
  return paid.length ? paid.map(add => add.label).join(" · ") : null;
}

/** A paid add-on as a plain fact: "Early check-in · 12:00 pm · $25 paid". */
export function paidAddOnFacts(entry: PropertyBookingEntry): string[] {
  return paidAddOns(entry).map(add => `${stayAddOnLabel(add.kind)} · ${formatStayTime(add.time)} · ${formatAddOnPrice(add.priceCents)} paid`);
}

/**
 * The key a turnover-cleaning dispatch run carries as `source_id` (`dispatchCleaningForStays`):
 * `<stay subjectId>:<checkout date>`. Blocks are `block:<blockId>`; an imported channel stay is
 * `channel:<connection>:<range>` and a lease `stay:<application>`. Null when the entry has no such id.
 */
export function turnoverCleaningKey(entry: PropertyBookingEntry): string | null {
  const checkout = entry.openEnded ? null : bookingCheckout(entry);
  if (!checkout) return null;
  if (entry.blockId) return `block:${entry.blockId}:${checkout}`;
  if (entry.connectionId) return `channel:${entry.connectionId}:${entry.sourceUid?.trim() || entry.start}:${checkout}`;
  if (entry.applicationId) return `stay:${entry.applicationId}:${checkout}`;
  return null;
}

/** "3 h", "2 h 30 min", "45 min". */
export function formatGapDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (!hours) return `${rest} min`;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}
