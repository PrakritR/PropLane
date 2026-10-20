/**
 * The pure half of the guest portal's Stays (a returning guest books again from /resident/stays):
 * the shapes the route returns, the 24-hour hold, the quick picks, the Upcoming | Past split, the
 * button wording the server's dry run decides, and the guest's texts. No server import, so the Stays
 * panel, the Book again sheet, the routes and the tests all read the same rules.
 */
import type { StayAddOnKind, StayAddOns } from "@/lib/bookings/stay-times";
import { addRangeDays, rangeDaysBetween } from "@/lib/room-availability-range";
import type { StayAddOnOffer } from "@/lib/short-stay/stay-add-ons";
import { formatShortStayMoney, shortStayCompactRange } from "@/lib/short-stay-request";

/** Written on `stayDetails.source` by the public card's "Request to book". */
export const PUBLIC_SHORT_STAY_SOURCE = "public_short_stay_request";
/** Written on `stayDetails.source` by `POST /api/resident/stays`. */
export const GUEST_PORTAL_SHORT_STAY_SOURCE = "guest_portal";
/** Written on `stayDetails.source` by a stay booked by text (the PropLane line's `request_short_stay`). */
export const SMS_SHORT_STAY_SOURCE = "sms_short_stay";
/** Every source is a guest's request the manager can Approve or Decline while it is a hold. */
export const SHORT_STAY_REQUEST_SOURCES: readonly string[] = [PUBLIC_SHORT_STAY_SOURCE, GUEST_PORTAL_SHORT_STAY_SOURCE, SMS_SHORT_STAY_SOURCE];

export function isShortStayRequestSource(source: unknown): boolean {
  return typeof source === "string" && SHORT_STAY_REQUEST_SOURCES.includes(source);
}

/** A confirmed stay that is not paid frees its nights this many hours after it was confirmed. */
export const SHORT_STAY_PAY_HOURS = 24;

/** A request the host does not answer frees its nights after this many hours. */
export const SHORT_STAY_HOLD_HOURS = 24;
/** Date ranges one request may carry (each is its own stay with its own outcome). */
export const SHORT_STAY_MAX_RANGES = 5;

export function shortStayHoldExpiresAt(now: Date = new Date()): string {
  return new Date(now.getTime() + SHORT_STAY_HOLD_HOURS * 3_600_000).toISOString();
}

export type GuestStayStatus = "confirmed" | "pending" | "declined" | "expired" | "cancelled";

/** One of the guest's own stays, as the Stays list draws it. Never carries another guest's data. */
export type GuestStay = {
  id: string;
  propertyId: string;
  roomId: string;
  propertyLabel: string;
  roomLabel: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  guests: number;
  status: GuestStayStatus;
  /** Pending only: when the host's 24 hours run out. */
  holdExpiresAt: string | null;
  /** Dollars; null when the stay carries no rate. */
  total: number | null;
  nightly: number | null;
  /** True when the listing still takes short stays, so a past row can offer Book again. */
  canBookAgain: boolean;
  /** The stay's CURRENT check-in / check-out wall times ("HH:MM", the property's clock): standard, or moved by a paid add-on. */
  checkInTime?: string;
  checkOutTime?: string;
  /** "HH:MM" the guest said they would arrive; informational. */
  estimatedArrival?: string | null;
  /** Paid early check-in / late checkout on this stay (requested, pending, paid or refunded). */
  addOns?: StayAddOns;
};

export type GuestStayBucket = "upcoming" | "past";
export const GUEST_STAY_BUCKETS: readonly GuestStayBucket[] = ["upcoming", "past"];

export function parseGuestStayBucket(value: string | undefined): GuestStayBucket | null {
  return GUEST_STAY_BUCKETS.find((bucket) => bucket === value) ?? null;
}

/** A stay is Upcoming while it is confirmed or pending and its check-out is still ahead (check-out day is exclusive). */
export function guestStayBucket(stay: Pick<GuestStay, "status" | "checkOut">, today: string): GuestStayBucket {
  const live = stay.status === "confirmed" || stay.status === "pending";
  return live && stay.checkOut > today ? "upcoming" : "past";
}

export function sortGuestStays(stays: readonly GuestStay[], bucket: GuestStayBucket): GuestStay[] {
  return [...stays].sort((a, b) => (bucket === "upcoming" ? a.checkIn.localeCompare(b.checkIn) : b.checkIn.localeCompare(a.checkIn)));
}

/** "Pending, expires in 22h" (under an hour: minutes). Past the deadline it reads "Pending, expiring". */
export function holdExpiresInLabel(expiresAt: string | null | undefined, now: Date = new Date()): string {
  const at = expiresAt ? Date.parse(expiresAt) : NaN;
  if (!Number.isFinite(at)) return "Pending";
  const minutes = Math.floor((at - now.getTime()) / 60_000);
  if (minutes <= 0) return "Pending, expiring";
  if (minutes < 60) return `Pending, expires in ${minutes}m`;
  return `Pending, expires in ${Math.floor(minutes / 60)}h`;
}

/** The status fact a row prints (no pill: the fact line says it). */
export function guestStayStatusLabel(stay: Pick<GuestStay, "status" | "checkOut" | "holdExpiresAt">, today: string, now: Date = new Date()): string {
  switch (stay.status) {
    case "confirmed":
      return stay.checkOut <= today ? "Completed" : "Confirmed";
    case "pending":
      return holdExpiresInLabel(stay.holdExpiresAt, now);
    case "declined":
      return "Declined";
    case "expired":
      return "Expired";
    default:
      return "Cancelled";
  }
}

export type ShortStayQuickPick = { id: "tomorrow-1" | "next-week-3"; label: string; checkIn: string; checkOut: string };

/** "Tomorrow · 1 night" and "Next week · 3 nights" (seven days out). `today` is a Pacific YYYY-MM-DD. */
export function shortStayQuickPicks(today: string): ShortStayQuickPick[] {
  const tomorrow = addRangeDays(today, 1);
  const nextWeek = addRangeDays(today, 7);
  return [
    { id: "tomorrow-1", label: "Tomorrow · 1 night", checkIn: tomorrow, checkOut: addRangeDays(tomorrow, 1) },
    { id: "next-week-3", label: "Next week · 3 nights", checkIn: nextWeek, checkOut: addRangeDays(nextWeek, 3) },
  ];
}

export type ShortStayRangeDraft = { checkIn: string; checkOut: string };

/** True when two [checkIn, checkOut) ranges share a night. */
export function shortStayRangesOverlap(a: ShortStayRangeDraft, b: ShortStayRangeDraft): boolean {
  return a.checkIn < b.checkOut && b.checkIn < a.checkOut;
}

export function shortStayRangeNights(range: ShortStayRangeDraft): number {
  return Math.max(0, rangeDaysBetween(range.checkIn, range.checkOut));
}

/* ─────────────────────── the server's per-range answer ─────────────────────── */

export type GuestRangeOutcome = "confirmed" | "pending" | "unavailable" | "invalid";

export type GuestRangeResult = {
  checkIn: string;
  checkOut: string;
  nights: number;
  total: number | null;
  outcome: GuestRangeOutcome;
  /** Present on `unavailable` / `invalid`. */
  error?: string;
  /** Present once a row was written (not on a dry run). */
  stayId?: string;
  /** Which paid add-ons these nights could carry (kind, time, price). Never says why one is not offered. */
  addOns?: StayAddOnOffer[];
  /** Add-ons the guest ticked that were not available when the stay was written, so they are not on it. */
  addOnsSkipped?: StayAddOnKind[];
};

export type GuestBookAction = "confirm" | "request" | "mixed" | "none";

/** What the primary button says, decided from the server's per-range answers (never guessed on the client). */
export function guestBookAction(results: readonly Pick<GuestRangeResult, "outcome">[]): GuestBookAction {
  const confirmed = results.filter((r) => r.outcome === "confirmed").length;
  const pending = results.filter((r) => r.outcome === "pending").length;
  if (confirmed && pending) return "mixed";
  if (confirmed) return "confirm";
  if (pending) return "request";
  return "none";
}

export function guestBookActionLabel(action: GuestBookAction): string {
  switch (action) {
    case "confirm":
      return "Confirm stay";
    case "request":
      return "Request to book";
    case "mixed":
      return "Confirm and request";
    default:
      return "Book";
  }
}

/** "2 confirmed, 1 pending" for a mixed cart. */
export function guestBookSummaryLine(results: readonly Pick<GuestRangeResult, "outcome">[]): string {
  const confirmed = results.filter((r) => r.outcome === "confirmed").length;
  const pending = results.filter((r) => r.outcome === "pending").length;
  return [confirmed ? `${confirmed} confirmed` : "", pending ? `${pending} pending` : ""].filter(Boolean).join(", ");
}

/* ─────────────────────── the guest's texts ─────────────────────── */

type StayTextInput = {
  roomLabel: string;
  propertyLabel: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  total: number | null;
};

function nightsMoney(input: StayTextInput): string {
  const nights = `${input.nights} ${input.nights === 1 ? "night" : "nights"}`;
  return input.total != null ? `${nights}, ${formatShortStayMoney(input.total)}` : nights;
}

/** "Oct 20 to 24" or "Oct 30 to Nov 2": the texts never use a dash. */
function plainRange(input: Pick<StayTextInput, "checkIn" | "checkOut">): string {
  return shortStayCompactRange(input.checkIn, input.checkOut).replace(/\s*–\s*/, " to ");
}

function stayWhere(input: StayTextInput): string {
  return `${input.roomLabel} at ${input.propertyLabel}`;
}

/** Confirmed at once (a returning guest, free nights) or after the host approves. No long dashes. */
export function guestStayConfirmedText(input: StayTextInput, portalUrl: string, payUrl?: string | null): string {
  if (payUrl) return `PropLane: Confirmed, ${stayWhere(input)}, ${plainRange(input)} (${nightsMoney(input)}). ${payLinkSentence(input.total)} ${payUrl}`;
  return `PropLane: Confirmed, ${stayWhere(input)}, ${plainRange(input)} (${nightsMoney(input)}). Check-in details are in your portal: ${portalUrl}`;
}

/** One sentence, then the link: opens the payment form on the page after a code that is texted to this number. */
export function payLinkSentence(total: number | null): string {
  return `${total != null ? `Pay ${formatShortStayMoney(total)}` : "Pay"} here within ${SHORT_STAY_PAY_HOURS} hours to keep it. We text you a code when you open it:`;
}

export function guestStayRequestedText(input: StayTextInput): string {
  return `PropLane: Request sent for ${plainRange(input)} (${nightsMoney(input)}). The host has ${SHORT_STAY_HOLD_HOURS} hours to confirm; we'll text you.`;
}

export function guestStayApprovedText(input: StayTextInput, portalUrl: string, payUrl?: string | null): string {
  if (payUrl) return `PropLane: Confirmed, ${plainRange(input)} at ${input.propertyLabel}. ${payLinkSentence(input.total)} ${payUrl}`;
  return `PropLane: Confirmed, ${plainRange(input)} at ${input.propertyLabel}. See it in your portal: ${portalUrl}`;
}

export function guestStayDeclinedText(input: StayTextInput, portalUrl: string): string {
  return `PropLane: The host couldn't confirm ${plainRange(input)}. Other nights are open in your portal: ${portalUrl}`;
}

export function guestStayUnpaidReleasedText(input: StayTextInput, portalUrl: string): string {
  return `PropLane: We didn't get payment for ${plainRange(input)} at ${input.propertyLabel} within ${SHORT_STAY_PAY_HOURS} hours, so those nights are free again. Book again in your portal: ${portalUrl}`;
}

export function guestStayExpiredText(input: StayTextInput, portalUrl: string): string {
  return `PropLane: The host didn't answer in time for ${plainRange(input)}, so those nights are free again. Try other nights in your portal: ${portalUrl}`;
}

/**
 * The sign-in pointer appended to a guest's confirmation text: the canonical sign-in PAGE, never a live
 * one-time link. The text leaves from the host's line and is stored in the host's outbox, so nothing in it
 * may open an account; the guest signs in there with their phone code.
 */
export function withGuestSignInPrompt(text: string, origin: string | null | undefined): string {
  const base = String(origin ?? "").trim().replace(/\/$/, "");
  return base ? `${text} Sign in at ${base}/auth/sign-in to see your stays.` : text;
}

/* ─────────────────── what a manager's save must not strip ─────────────────── */

const CARRIED_STAY_DETAIL_KEYS = ["guests", "holdExpiresAt", "decision", "confirmedAt", "decidedAt"] as const;

/**
 * The booking editor posts back only the fields it draws. For a guest's stay, the guest's login
 * (`residentUserId`), the head-count the capacity trigger weighs (`stayDetails.guests`), the hold's
 * deadline and how it was answered are server-owned, so a manager's save carries them forward from the
 * stored row. Returns the merged `row_data`, or null when there is nothing to carry (not a guest stay).
 *
 * `stayDetails.source` is PINNED rather than merely backfilled: it is what marks the row as a guest's
 * request, and the editor draws it in an (unchangeable) Source dropdown. A save that overwrote it with
 * "Direct" left the request unanswerable - Approve/Decline vanish, `decideShortStayHold` refuses it as
 * already answered, and the expiry cron cancels the nights as an unpaid hold without ever telling the
 * guest.
 */
export function carryGuestStayFields(existing: unknown, next: unknown): Record<string, unknown> | null {
  const prior = existing && typeof existing === "object" && !Array.isArray(existing) ? (existing as Record<string, unknown>) : null;
  const incoming = next && typeof next === "object" && !Array.isArray(next) ? (next as Record<string, unknown>) : null;
  if (!prior || !incoming) return null;
  const priorDetails = prior.stayDetails && typeof prior.stayDetails === "object" ? (prior.stayDetails as Record<string, unknown>) : {};
  if (!prior.residentUserId && !isShortStayRequestSource(priorDetails.source)) return null;
  const details = incoming.stayDetails && typeof incoming.stayDetails === "object" ? { ...(incoming.stayDetails as Record<string, unknown>) } : {};
  for (const key of CARRIED_STAY_DETAIL_KEYS) {
    if (details[key] === undefined && priorDetails[key] !== undefined) details[key] = priorDetails[key];
  }
  if (isShortStayRequestSource(priorDetails.source)) details.source = priorDetails.source;
  else if (details.source === undefined && priorDetails.source !== undefined) details.source = priorDetails.source;
  return {
    ...incoming,
    ...(prior.residentUserId && !incoming.residentUserId ? { residentUserId: prior.residentUserId } : {}),
    ...(prior.guests !== undefined && incoming.guests === undefined ? { guests: prior.guests } : {}),
    stayDetails: details,
  };
}
