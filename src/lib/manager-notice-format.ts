/**
 * The ONE formatter for every manager / owner / staff notice about a person or a stay.
 *
 * Every channel (the action-event bus, the Team chat line, the booking reminders, the lead alert, the inbound-text forward,
 * the morning digest, and the manager's SMS agent) builds its copy here, so a booking reads the same on a phone, in the
 * Assistant and in an email. Pure: no database, no clock. A part the caller does not know is left out, never invented.
 *
 * Rules (captain, Nov 14):
 *  - WHO is the guest or prospect, never the workspace owner (the owner is only the sender of a system-raised event).
 *    A feed that names nobody ("CLOSED - Not available", "Reserved", a bare confirmation code) reads
 *    "<Channel> guest", and the confirmation code rides beside the channel, never in place of a real name.
 *  - WHERE is the house short name and the room. WHEN is a Pacific date range with nights.
 *  - A closed or blocked room is not a stay: no check-in or check-out is ever announced for it.
 *  - A notice that points at a record carries the link to that exact record.
 */
import { dayRangeLabel } from "@/lib/one-number/ops-alert-lines";
import { isHostBlockSummary } from "@/lib/channel-calendar/host-block";

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** A channel's confirmation code: 8-12 capitals/digits with at least one of each ("HMMS4HRSEB"). */
export function looksLikeConfirmationCode(value: string | null | undefined): boolean {
  const raw = (value ?? "").trim();
  return /^[A-Z0-9]{8,12}$/.test(raw) && /\d/.test(raw) && /[A-Z]/.test(raw);
}

/** A label a feed or the app makes up when it has no real name. */
const PLACEHOLDER_NAME = /^(booked\b|reserved\b|closed\b|not available\b|unavailable\b|blocked\b|.*\bguest(\s*[·-]|$)|.*\bblock$|airbnb$|booking(\.com)?$|vrbo$)/i;

/** True when the text is a real person's name (not a feed placeholder, a confirmation code or an email). */
export function isRealGuestName(name: string | null | undefined): boolean {
  const raw = (name ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return false;
  if (PLACEHOLDER_NAME.test(raw) || looksLikeConfirmationCode(raw) || /@/.test(raw)) return false;
  return true;
}

/** Booking.com and VRBO privacy-strip REAL reservations to this summary; it is a guest, never a closed room. */
const PRIVACY_STRIPPED_RESERVATION = /^closed\s*-\s*not available$/i;

/**
 * A room a manager closed, or a channel's own host block (the whole summary, as `isHostBlockSummary` reads it): nobody
 * checks in or out of it. "CLOSED - Not available" is a privacy-stripped reservation and is NOT closed — skipping it
 * would drop the check-in/out of every Booking.com stay.
 */
export function isClosedBlockLabel(name: string | null | undefined): boolean {
  const raw = (name ?? "").replace(/\s+/g, " ").trim();
  if (!raw || PRIVACY_STRIPPED_RESERVATION.test(raw)) return false;
  if (isHostBlockSummary(raw)) return true;
  return /^closed\b/i.test(raw);
}

/**
 * The guest as a notice names them. A real name always wins; otherwise "<Channel> guest" with the confirmation code
 * after it (so an unnamed reservation is still findable), and "Guest" when nothing is known.
 */
export function guestNoticeName(input: { name?: string | null; channel?: string | null; code?: string | null }): string {
  if (isRealGuestName(input.name)) return (input.name ?? "").replace(/\s+/g, " ").trim();
  const channel = (input.channel ?? "").trim();
  const code = (input.code ?? "").trim() || (looksLikeConfirmationCode(input.name) ? (input.name ?? "").trim() : "");
  const base = channel ? `${channel} guest` : "Guest";
  return code ? `${base} ${code}` : base;
}

/** "5259 Brooklyn Ave · Room 2": the house and the room, either may be missing. */
export function noticePlace(house?: string | null, room?: string | null): string {
  return [house, room].map((part) => (part ?? "").replace(/\s+/g, " ").trim()).filter(Boolean).join(" · ");
}

/** Whole nights between a check-in and the (exclusive) check-out day; 0 when either is not a day key. */
export function nightsBetween(checkIn: string | null | undefined, checkOutExclusive: string | null | undefined): number {
  if (!DAY_KEY.test(checkIn ?? "") || !DAY_KEY.test(checkOutExclusive ?? "")) return 0;
  const nights = Math.round((Date.parse(`${checkOutExclusive}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / DAY_MS);
  return nights > 0 ? nights : 0;
}

/** "Nov 6–9 (3 nights)". The check-out day is exclusive. Empty when the check-in is unreadable. */
export function stayDatesLabel(checkIn: string | null | undefined, checkOutExclusive: string | null | undefined): string {
  if (!DAY_KEY.test(checkIn ?? "")) return "";
  const range = dayRangeLabel(checkIn!, DAY_KEY.test(checkOutExclusive ?? "") ? checkOutExclusive! : "");
  const nights = nightsBetween(checkIn, checkOutExclusive);
  return nights > 0 ? `${range} (${nights} ${nights === 1 ? "night" : "nights"})` : range;
}

/** "...4812" for a phone: the last four digits only, never the number. Empty when there are fewer than four digits. */
export function phoneTail(phone: string | null | undefined): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= 4 ? `...${digits.slice(-4)}` : "";
}

const money = (amount: number | string | null | undefined): string => {
  if (amount === null || amount === undefined || amount === "") return "";
  if (typeof amount === "string") return amount.trim();
  return Number.isFinite(amount) ? `$${Number.isInteger(amount) ? amount.toLocaleString("en-US") : amount.toFixed(2)}` : "";
};

// ---- bookings -------------------------------------------------------------------------------

export type BookingNoticeFacts = {
  created: boolean;
  /** The feed's or the manager's own name for the guest ("" when the channel hides it). */
  guestName?: string | null;
  /** "Airbnb", "Booking.com", "Vrbo", "PropLane", or the site a manager named. */
  channel?: string | null;
  code?: string | null;
  house?: string | null;
  room?: string | null;
  checkIn?: string | null;
  /** The day the guest leaves (exclusive). */
  checkOutExclusive?: string | null;
  /** The stay is open-ended (a long stay with no end yet). */
  openEnded?: boolean;
  /** A total or payout already formatted ("$420") or in dollars. */
  amount?: number | string | null;
  url?: string | null;
};

/**
 * "New booking: Priya Nair, 5259 Brooklyn Ave · Room 2, Nov 6–9 (3 nights), Airbnb HMX12345, $420."
 * `sms` is one plain sentence (the link on its own line); `lines` is the same facts as labelled lines for an email.
 */
export function formatBookingNotice(facts: BookingNoticeFacts): { subject: string; sms: string; lines: string[] } {
  const guest = guestNoticeName({ name: facts.guestName, channel: facts.channel, code: facts.code });
  // The code already trails an unnamed guest's label; a named guest gets it beside the channel.
  // An unnamed guest's label already carries the channel and the code, so the source is not repeated after the dates.
  const named = isRealGuestName(facts.guestName);
  const via = named ? [facts.channel?.trim(), facts.code?.trim()].filter(Boolean).join(" ") : "";
  const place = noticePlace(facts.house, facts.room);
  const dates = facts.openEnded ? `${dayRangeLabel(facts.checkIn ?? "", "")} (open-ended)` : stayDatesLabel(facts.checkIn, facts.checkOutExclusive);
  const amount = money(facts.amount);
  const lead = facts.created ? "New booking" : "Booking cancelled";
  const sentence = `${lead}: ${[guest, place, dates, via, amount].filter(Boolean).join(", ")}.`;
  const lines = [
    facts.created ? "A booking was added." : "A booking was cancelled.",
    `Guest: ${guest}`,
    ...(facts.house?.trim() ? [`House: ${facts.house.trim()}`] : []),
    ...(facts.room?.trim() ? [`Room: ${facts.room.trim()}`] : []),
    ...(dates ? [`Dates: ${dates}`] : []),
    ...(via ? [`Source: ${via}`] : []),
    ...(amount ? [`Amount: ${amount}`] : []),
  ];
  // The subject names the channel ("New Houfy booking", "Airbnb booking cancelled") — the source a manager scans for.
  const channel = facts.channel?.trim();
  const subject = channel ? (facts.created ? `New ${channel} booking` : `${channel} booking cancelled`) : lead;
  return { subject, sms: facts.url ? `${sentence}\n${facts.url}` : sentence, lines };
}

// ---- channel sync failures ------------------------------------------------------------------

export type SyncFailureFacts = {
  channel?: string | null;
  house?: string | null;
  room?: string | null;
  /** Whole hours since PropLane last read the channel (0 or unknown reads "has never been read"). */
  hoursSince?: number | null;
  /** The channel's own error ("Booking.com calendar returned 404."), when there is one. */
  error?: string | null;
  url?: string | null;
};

/**
 * "Booking.com · 4709A 8th Ave · Room 8 has not synced in 7 hours (Booking.com calendar returned 404). New bookings
 * on it may be missing from PropLane." `sms` is one plain sentence with the link on its own line.
 */
export function formatSyncFailureNotice(facts: SyncFailureFacts): { subject: string; sms: string; lines: string[] } {
  const channel = (facts.channel ?? "").trim() || "A channel calendar";
  const place = noticePlace(facts.house, facts.room);
  const hours = Number.isFinite(facts.hoursSince) && (facts.hoursSince ?? 0) > 0 ? Math.floor(facts.hoursSince!) : 0;
  const since = hours >= 48 ? `${Math.floor(hours / 24)} days` : `${hours} ${hours === 1 ? "hour" : "hours"}`;
  const error = (facts.error ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
  const what = [channel, place].filter(Boolean).join(" \u00b7 ");
  const state = hours > 0 ? `has not synced in ${since}` : "has not synced yet";
  const sentence = `${what} ${state}${error ? ` (${error})` : ""}. New bookings on it may be missing from PropLane.`;
  const lines = [
    "A channel calendar is not syncing.",
    `Channel: ${channel}`,
    ...(facts.house?.trim() ? [`House: ${facts.house.trim()}`] : []),
    ...(facts.room?.trim() ? [`Room: ${facts.room.trim()}`] : []),
    ...(hours > 0 ? [`Last synced: ${since} ago`] : ["Last synced: never"]),
    ...(error ? [`Error: ${error}`] : []),
  ];
  return { subject: `${channel} calendar is not syncing`, sms: facts.url ? `${sentence}\n${facts.url}` : sentence, lines };
}

// ---- stay reminders -------------------------------------------------------------------------

export type StayReminderFacts = {
  kind: "check_in" | "check_out";
  guestName?: string | null;
  channel?: string | null;
  code?: string | null;
  house?: string | null;
  room?: string | null;
  checkIn: string;
  checkOutExclusive?: string | null;
  /** "3 PM" style, already formatted, when the stay carries its own time. */
  timeLabel?: string | null;
};

/**
 * "Check-in tomorrow · Priya Nair · 5259 Brooklyn Ave · Room 2 · Nov 6–9 (3 nights) · Airbnb HMX12345"
 * "Check-out today · Priya Nair · 4709A 8th Ave · Room 6 · Airbnb HMMS4HRSEB · room free from Nov 14"
 * A name always replaces the raw code as the person; the code stays beside the channel as the reservation id.
 */
export function formatStayReminderLine(facts: StayReminderFacts): string {
  const guest = guestNoticeName({ name: facts.guestName, channel: facts.channel, code: facts.code });
  const named = isRealGuestName(facts.guestName);
  const via = [facts.channel?.trim(), named ? facts.code?.trim() : ""].filter(Boolean).join(" ");
  const place = [facts.house, facts.room].map((p) => (p ?? "").trim()).filter(Boolean);
  const free = facts.checkOutExclusive && DAY_KEY.test(facts.checkOutExclusive) ? `room free from ${dayRangeLabel(facts.checkOutExclusive, "")}` : "";
  const time = (facts.timeLabel ?? "").trim();
  return facts.kind === "check_in"
    ? ["Check-in tomorrow", guest, ...place, stayDatesLabel(facts.checkIn, facts.checkOutExclusive), via, time].filter(Boolean).join(" · ")
    : ["Check-out today", guest, ...place, via, time, free].filter(Boolean).join(" · ");
}

// ---- leads ----------------------------------------------------------------------------------

export type LeadFitRoom = { room: string; rent?: number | null; availability?: string | null };

export type LeadNoticeFacts = {
  name?: string | null;
  phone?: string | null;
  /** "206 text", "Zillow", "Roomies", "Listing page", "Facebook" ... */
  source?: string | null;
  house?: string | null;
  budgetMax?: number | null;
  moveInDate?: string | null;
  moveInAsap?: boolean;
  /** 0 is month to month. */
  leaseMonths?: number | null;
  area?: string | null;
  /** Rooms at this house that fit the lead and are free when they want to move in. */
  fitRooms?: readonly LeadFitRoom[];
  /** The one-tap next step: the thread to reply in, or the tour link. */
  url?: string | null;
};

/**
 * "New lead: Maya R. (...4812, 206 text) for 4709A 8th Ave. Budget $1,200, move-in Nov 14, 3 mo, University District.
 *  Fits: Room 3 $1,150 now, Room 6 $1,190 Dec 1. Reply or book a tour: <link>"
 */
export function formatLeadNotice(facts: LeadNoticeFacts): string {
  const tail = phoneTail(facts.phone);
  const who = isRealGuestName(facts.name) ? (facts.name ?? "").trim() : tail ? `New texter ${tail}` : "New lead";
  const id = [isRealGuestName(facts.name) ? tail : "", facts.source?.trim()].filter(Boolean).join(", ");
  const head = `New lead: ${who}${id ? ` (${id})` : ""}${facts.house?.trim() ? ` for ${facts.house.trim()}` : ""}.`;
  const asks: string[] = [];
  if (facts.budgetMax) asks.push(`budget ${money(facts.budgetMax)}`);
  if (facts.moveInAsap) asks.push("move-in as soon as possible");
  else if (facts.moveInDate && DAY_KEY.test(facts.moveInDate)) asks.push(`move-in ${dayRangeLabel(facts.moveInDate, "")}`);
  if (facts.leaseMonths !== null && facts.leaseMonths !== undefined) asks.push(facts.leaseMonths === 0 ? "month to month" : `${facts.leaseMonths} mo`);
  if (facts.area?.trim()) asks.push(facts.area.trim());
  const fits = (facts.fitRooms ?? []).slice(0, 3).map((r) => [r.room, money(r.rent ?? null), (r.availability ?? "").replace(/^available\s+/i, "")].filter(Boolean).join(" "));
  const fitText = facts.fitRooms
    ? fits.length > 0
      ? `Fits: ${fits.join(", ")}.`
      : "No room here fits yet."
    : "";
  const parts = [head, ...(asks.length ? [`${asks[0]!.replace(/^./, (c) => c.toUpperCase())}${asks.length > 1 ? `, ${asks.slice(1).join(", ")}` : ""}.`] : []), ...(fitText ? [fitText] : [])];
  const body = parts.join(" ");
  return facts.url ? `${body} Reply or book a tour: ${facts.url}` : body;
}

// ---- inbound text forward -------------------------------------------------------------------

/** A bare menu answer ("1", "2.", "yes", "ok"): meaningless without the question it answered. */
export function isMenuAnswer(body: string | null | undefined): boolean {
  return /^\s*(?:[1-9]|y|n|yes|no|ok|okay|sure)\s*[.!]?\s*$/i.test(body ?? "");
}

export type InboundForwardFacts = {
  /** A real name when PropLane knows one. */
  name?: string | null;
  phone: string;
  /** "resident" | "prospect" | "vendor" ... */
  role?: string | null;
  house?: string | null;
  room?: string | null;
  body: string;
  /** What PropLane last asked them, when the body is a menu answer. */
  lastQuestion?: string | null;
};

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3).trimEnd()}...` : flat;
};

/** "Maya R...4812" style label: a real name with the tail, else "New texter ...4812". */
export function inboundSenderLabel(input: { name?: string | null; phone: string; role?: string | null }): string {
  const tail = phoneTail(input.phone);
  if (isRealGuestName(input.name)) return tail ? `${(input.name ?? "").trim()} (${tail})` : (input.name ?? "").trim();
  if (input.role === "resident") return tail ? `Resident ${tail}` : "A resident";
  return tail ? `New texter ${tail}` : "New texter";
}

/**
 * "Maya Rao (...4812) about 4709A 8th Ave · Room 3: "1" (answering: "Which home? 1) 4709A 2) 5257")"
 * The question rides along only for a bare menu answer; a real message stands on its own.
 */
export function formatInboundForward(facts: InboundForwardFacts): string {
  const label = inboundSenderLabel({ name: facts.name, phone: facts.phone, role: facts.role });
  const place = noticePlace(facts.house, facts.room);
  const body = facts.body.replace(/\s+/g, " ").trim() || "(no text)";
  const answered = isMenuAnswer(body) && facts.lastQuestion?.trim() ? ` (answering: "${clip(facts.lastQuestion, 110)}")` : "";
  return `${label}${place ? ` about ${place}` : ""}: ${body}${answered}`;
}

// ---- digest ---------------------------------------------------------------------------------

export type DigestPerson = { name: string; room?: string | null; house?: string | null; detail?: string | null };

/** "3 check-ins today: Priya N. (5259 R2, Airbnb), ...": the first few names, then "+N more". */
export function digestSection(label: string, people: readonly DigestPerson[], shown = 3): string {
  if (people.length === 0) return "";
  const list = people.slice(0, shown).map((p) => {
    const where = [p.house, p.room].map((x) => (x ?? "").trim()).filter(Boolean).join(" ");
    const extra = [where, (p.detail ?? "").trim()].filter(Boolean).join(", ");
    return extra ? `${p.name} (${extra})` : p.name;
  });
  const more = people.length - shown;
  return `${people.length} ${label}: ${list.join("; ")}${more > 0 ? ` +${more} more` : ""}.`;
}
