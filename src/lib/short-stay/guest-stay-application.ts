/**
 * A guest's short stay drawn as an APPLICATION row (captain, Oct 27: "move stays into application, same UI for
 * both short term and long term applications, no need for extra tab"). The resident Application page keeps its
 * three sections - Sent | Approved | Denied - and this is the one decision of which section a stay is in, plus
 * the words its row prints. Pure and client-safe; the panel, the section counts and the tests all read it.
 *
 *   pending                              -> Sent      (requested, the host has 24 hours)
 *   confirmed                            -> Approved  (Pay now while the stay's charge is unpaid)
 *   declined / expired / cancelled       -> Denied
 */
import type { ResidentApplicationSection } from "@/lib/resident-application-sections";
import type { GuestStay } from "@/lib/short-stay/guest-stays";
import { formatShortStayMoney, shortStayCompactRange } from "@/lib/short-stay-request";

export function guestStaySectionOf(stay: Pick<GuestStay, "status">): ResidentApplicationSection {
  if (stay.status === "confirmed") return "approved";
  if (stay.status === "pending") return "sent";
  return "denied";
}

export function countGuestStaySections(stays: ReadonlyArray<Pick<GuestStay, "status">>): Record<ResidentApplicationSection, number> {
  const counts: Record<ResidentApplicationSection, number> = { sent: 0, approved: 0, denied: 0 };
  for (const stay of stays) counts[guestStaySectionOf(stay)] += 1;
  return counts;
}

/** "Short stay · Oct 20–24 · 4 nights" - the row's place line. */
export function guestStayPlaceLine(stay: Pick<GuestStay, "checkIn" | "checkOut" | "nights">): string {
  return `Short stay · ${shortStayCompactRange(stay.checkIn, stay.checkOut)} · ${stay.nights} ${stay.nights === 1 ? "night" : "nights"}`;
}

/** The row's title: house · room. */
export function guestStayTitle(stay: Pick<GuestStay, "propertyLabel" | "roomLabel">): string {
  return `${stay.propertyLabel} · ${stay.roomLabel}`;
}

/** The amount the figure column prints; nothing when the stay carries no rate. */
export function guestStayFigure(stay: Pick<GuestStay, "total">): string | undefined {
  return stay.total != null ? formatShortStayMoney(stay.total) : undefined;
}

export type GuestStayRowActions = {
  /** Approved and unpaid: the row's Pay now. */
  payNow: boolean;
  /** A live request or an approved stay that has not ended: the Check-in and checkout sheet. */
  checkInTimes: boolean;
  /** A confirmed stay that has not ended: the numbered Check-in guide. */
  checkInGuide: boolean;
  /** The listing still takes short stays: Request again. */
  requestAgain: boolean;
};

/** Which ⋯ menu entries a stay offers. `today` is a Pacific YYYY-MM-DD. */
export function guestStayRowActions(stay: Pick<GuestStay, "status" | "payment" | "checkOut" | "canBookAgain">, today: string): GuestStayRowActions {
  const live = stay.checkOut > today;
  return {
    payNow: stay.status === "confirmed" && stay.payment === "due" && live,
    checkInTimes: (stay.status === "confirmed" || stay.status === "pending") && live,
    // The numbered Check-in guide (door photos, codes from 24 h before arrival, "I'm in"): a confirmed stay only.
    checkInGuide: stay.status === "confirmed" && live,
    requestAgain: stay.canBookAgain,
  };
}

/** One search haystack per stay (the page's search box matches house, room and the word "short stay"). */
export function guestStaySearchText(stay: Pick<GuestStay, "propertyLabel" | "roomLabel">): string {
  return `${stay.propertyLabel} ${stay.roomLabel} short stay`.toLowerCase();
}

/** Rows within a section: the next stay first for Sent and Approved, the most recent first for Denied. */
export function sortGuestStaysForSection(stays: readonly GuestStay[], section: ResidentApplicationSection): GuestStay[] {
  return [...stays].sort((a, b) => (section === "denied" ? b.checkIn.localeCompare(a.checkIn) : a.checkIn.localeCompare(b.checkIn)));
}
