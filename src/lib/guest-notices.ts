/**
 * Plain copy for the automated texts and emails a GUEST (a visitor with no PropLane account) receives:
 * a tour confirmation and a hold confirmation. Pure builders, no I/O. Nothing here links into the resident
 * portal: a guest has no login, so the way to change anything is to reply or text the PropLane line.
 */
import { formatTourTimeRange } from "@/lib/tour-notifications";

export const GUEST_TOUR_CONFIRMED_SUBJECT = "Your tour is confirmed";

export type GuestTourFacts = {
  guestName?: string | null;
  propertyTitle: string;
  propertyAddress?: string | null;
  roomLabel?: string | null;
  startIso: string;
  endIso: string;
  /** Pre-arrival notes the manager typed for this tour. */
  instructions?: string | null;
  /** The PropLane line a guest can text, in display form such as "+1 206 555 0100"; absent = reply-only wording. */
  propLaneLine?: string | null;
  /** Public listing page (never a /resident link). */
  listingUrl?: string | null;
};

function rescheduleLine(line: string | null | undefined): string {
  return line?.trim()
    ? `To reschedule or cancel, reply to this message or text us at ${line.trim()}.`
    : "To reschedule or cancel, reply to this message.";
}

export function buildGuestTourConfirmedEmail(f: GuestTourFacts): { subject: string; text: string } {
  const name = f.guestName?.trim();
  const lines = [
    name ? `Hi ${name},` : "Hi,",
    "",
    `Your tour of ${f.propertyTitle.trim() || "the home"} is confirmed.`,
    "",
    `When: ${formatTourTimeRange(f.startIso, f.endIso)}`,
  ];
  if (f.propertyAddress?.trim()) lines.push(`Address: ${f.propertyAddress.trim()}`);
  if (f.roomLabel?.trim()) lines.push(`Room: ${f.roomLabel.trim()}`);
  if (f.instructions?.trim()) lines.push("", f.instructions.trim());
  lines.push("", rescheduleLine(f.propLaneLine));
  if (f.listingUrl?.trim()) lines.push("", `The listing: ${f.listingUrl.trim()}`);
  lines.push("", "PropLane");
  return { subject: GUEST_TOUR_CONFIRMED_SUBJECT, text: lines.join("\n") };
}

/** One text, always carrying a public link so no resident-portal link is appended to it. */
export function buildGuestTourConfirmedSms(f: GuestTourFacts): string {
  const where = f.propertyAddress?.trim() ? ` at ${f.propertyAddress.trim()}` : "";
  const reply = f.propLaneLine?.trim()
    ? `To change it, reply here or text ${f.propLaneLine.trim()}.`
    : "To change it, reply here.";
  const link = f.listingUrl?.trim() ? ` ${f.listingUrl.trim()}` : "";
  return `Your tour of ${f.propertyTitle.trim() || "the home"}${where} is confirmed for ${formatTourTimeRange(f.startIso, f.endIso)}. ${reply}${link}`.trim();
}

export type HoldPlacedFacts = {
  /** "$100" */
  amountLabel: string;
  roomLabel: string;
  /** Already formatted, "Nov 20". */
  expiresLabel: string;
};

export const HOLD_PLACED_EVENT = "hold_placed";

/** The resident/guest copy for a hold that was just placed. */
export function renderHoldPlaced(f: HoldPlacedFacts): { subject: string; text: string; smsText: string } {
  const text = `${f.amountLabel} hold placed for ${f.roomLabel}, expires ${f.expiresLabel}; credited to your deposit if you sign by then.`;
  return { subject: `Hold placed · ${f.roomLabel}`, text, smsText: text };
}
