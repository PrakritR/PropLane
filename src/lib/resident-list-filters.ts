import { isPlaceholderImportEmail } from "@/lib/portfolio-import/placeholder-email";

/**
 * Residents list: who counts as a resident, and the Stay / Contact filters.
 *
 * A short stay is a guest booked through a channel or the short-stay flow, not a long-term tenant.
 * The Dashboard's rooms-occupied figure and the Residents tab count must tell one story, so the
 * list counts long-term people by default and keeps guests one choice away (Stay -> Short stays),
 * and always in Bookings.
 */

export type ResidentStayFilter = "long_term" | "short" | "all";
export const RESIDENT_STAY_FILTER_DEFAULT: ResidentStayFilter = "long_term";
export const RESIDENT_STAY_FILTER_OPTIONS: { value: ResidentStayFilter; label: string }[] = [
  { value: "long_term", label: "Long-term" },
  { value: "short", label: "Short stays" },
  { value: "all", label: "All" },
];

export type ResidentContactFilter = "all" | "missing_phone";
export const RESIDENT_CONTACT_FILTER_DEFAULT: ResidentContactFilter = "all";
export const RESIDENT_CONTACT_FILTER_OPTIONS: { value: ResidentContactFilter; label: string }[] = [
  { value: "all", label: "Everyone" },
  { value: "missing_phone", label: "Missing phone" },
];

/** The row fields the stay classification reads; every one already exists on the stored row. */
export type ShortStayFacts = {
  bookingResidency?: boolean | null;
  icalConnectionId?: string | null;
  icalSourceUid?: string | null;
  /** Set on a row derived from a channel booking (Airbnb, Booking.com, Vrbo, other calendar). */
  channelStay?: unknown;
  application?: { rentalType?: string | null } | null;
};

/** True for a short stay: a booking residency, a non-standard rental type, an iCal source, or a channel stay. */
export function isShortStay(row: ShortStayFacts | null | undefined): boolean {
  if (!row) return false;
  if (row.bookingResidency === true) return true;
  const rentalType = row.application?.rentalType;
  // An absent rentalType is a standard (long-term) application, never a short stay.
  if (typeof rentalType === "string" && rentalType.trim() !== "" && rentalType !== "standard") return true;
  if (typeof row.icalConnectionId === "string" && row.icalConnectionId.trim() !== "") return true;
  if (typeof row.icalSourceUid === "string" && row.icalSourceUid.trim() !== "") return true;
  return Boolean(row.channelStay);
}

export function matchesStayFilter(shortStay: boolean, filter: ResidentStayFilter): boolean {
  if (filter === "all") return true;
  return filter === "short" ? shortStay : !shortStay;
}

/** A phone is on record when any stored number has digits. */
export function hasPhoneOnRecord(...phones: Array<string | null | undefined>): boolean {
  return phones.some((p) => typeof p === "string" && p.replace(/\D/g, "").length >= 7);
}

/** An address that is empty or the import placeholder cannot receive mail. */
export function hasRealEmail(email: string | null | undefined): boolean {
  const e = (email ?? "").trim();
  return e.includes("@") && !isPlaceholderImportEmail(e);
}

export function matchesContactFilter(phoneOnRecord: boolean, filter: ResidentContactFilter): boolean {
  return filter === "missing_phone" ? !phoneOnRecord : true;
}

/** Message body for "Ask these N for their phone". The link is the resident's Settings -> Profile. */
export function phoneRequestMessage(opts: { name: string; hasRealEmail: boolean; profileUrl: string }): string {
  const first = opts.name.trim().split(/\s+/)[0] || "there";
  const emailLine = opts.hasRealEmail ? "" : " Please add a real email address there too.";
  return `Hi ${first}, please add and verify your phone number so we can reach you about your home: ${opts.profileUrl}.${emailLine}`;
}
