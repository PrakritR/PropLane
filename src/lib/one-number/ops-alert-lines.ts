/**
 * The one short text each ops alert sends to the owner's alert phones (pure: no database, no clock).
 * `alertLine` (ops-alerts.server.ts) still redacts card numbers and folds every line to GSM-7 afterward,
 * so the dashes below may be typographic here and plain hyphens on the wire.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A label a feed or the app makes up when it has no real name ("Booked (Airbnb)", "Booking.com guest", "CLOSED - Not available", "Reserved"). */
const GENERIC_GUEST = /^(booked\b|reserved\b|closed\b|not available\b|blocked\b|.*\bguest(\s*·|$)|.*\bblock$)/i;

/** "Anthony" from "Anthony Rivera"; "Guest" when the name is a placeholder or empty. First names only in a text. */
export function guestFirstName(name: string | null | undefined): string {
  const raw = (name ?? "").replace(/\s+/g, " ").trim();
  if (!raw || GENERIC_GUEST.test(raw) || /@/.test(raw)) return "Guest";
  const first = raw.split(" ")[0]!.replace(/[^\p{L}'’.-]/gu, "");
  return first || "Guest";
}

/** "Vaishnavi S." from "Vaishnavi Sharma"; just the first name when there is no surname. */
export function shortPerson(name: string | null | undefined): string {
  const raw = (name ?? "").replace(/\s+/g, " ").trim();
  if (!raw || /@/.test(raw)) return "Someone";
  const parts = raw.split(" ").filter(Boolean);
  const first = parts[0]!.replace(/[^\p{L}'’.-]/gu, "");
  const last = parts.length > 1 ? parts[parts.length - 1]!.replace(/[^\p{L}]/gu, "") : "";
  if (!first) return "Someone";
  return last ? `${first} ${last[0]!.toUpperCase()}.` : first;
}

/** "15:00" -> "3 PM", "11:30" -> "11:30 AM". Empty for anything that is not an HH:MM wall time. */
export function clockLabel(time: string | null | undefined): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec((time ?? "").trim());
  if (!match) return "";
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return "";
  const suffix = hours >= 12 ? "PM" : "AM";
  const h12 = hours % 12 === 0 ? 12 : hours % 12;
  return minutes === 0 ? `${h12} ${suffix}` : `${h12}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

function parts(key: string): { month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  return match ? { month: Number(match[2]), day: Number(match[3]) } : null;
}

/** "Nov 6–9", "Nov 29–Dec 2" for a check-in date and the (exclusive) check-out date. */
export function dayRangeLabel(checkIn: string, checkOutExclusive: string): string {
  const a = parts(checkIn);
  const b = parts(checkOutExclusive);
  if (!a) return "";
  const from = `${MONTHS[a.month - 1]} ${a.day}`;
  if (!b || checkOutExclusive <= checkIn) return from;
  return b.month === a.month ? `${from}–${b.day}` : `${from}–${MONTHS[b.month - 1]} ${b.day}`;
}

/** The day after a YYYY-MM-DD key (UTC arithmetic on a date key: no zone involved). */
export function nextDayKey(key: string): string {
  const ms = Date.parse(`${key}T00:00:00Z`);
  return Number.isFinite(ms) ? new Date(ms + 86_400_000).toISOString().slice(0, 10) : key;
}

export type DigestMove = {
  room: string;
  /** A first name; "Guest" when the stay has no real name. */
  guest: string;
  /** The booking channel's name ("Airbnb"), absent for PropLane's own stays. */
  channel?: string | null;
  /** "HH:MM" property wall time. */
  time?: string | null;
};

function moveText(move: DigestMove, withChannel: boolean): string {
  const bits = [move.guest, ...(withChannel && move.channel ? [move.channel] : []), ...(clockLabel(move.time) ? [clockLabel(move.time)] : [])];
  return `${move.room} (${bits.join(", ")})`;
}

function side(label: string, moves: readonly DigestMove[], withChannel: boolean, shown: number): string {
  const list = moves.slice(0, shown).map((move) => moveText(move, withChannel));
  const more = moves.length - shown;
  return `${label} ${list.join(", ")}${more > 0 ? ` +${more} more` : ""}.`;
}

/**
 * "Today 4709A — check-in Room 4 (Anthony, Airbnb, 3 PM). Check-out Room 7 (Kumaran, 11 AM)."
 * Empty when the house has neither. Longer than `maxChars` it drops the channel names, then the
 * trailing stays ("+2 more"), so the line a phone gets is always whole.
 */
export function checkinDigestLine(
  house: string,
  checkIns: readonly DigestMove[],
  checkOuts: readonly DigestMove[],
  maxChars = 420,
): string {
  if (checkIns.length === 0 && checkOuts.length === 0) return "";
  const build = (withChannel: boolean, inShown: number, outShown: number) =>
    [
      `Today ${house.trim() || "your house"} —`,
      ...(checkIns.length ? [side("check-in", checkIns, withChannel, inShown)] : []),
      ...(checkOuts.length ? [side(checkIns.length ? "Check-out" : "check-out", checkOuts, withChannel, outShown)] : []),
    ].join(" ");
  const full = build(true, checkIns.length, checkOuts.length);
  if (full.length <= maxChars) return full;
  let inShown = checkIns.length;
  let outShown = checkOuts.length;
  for (;;) {
    const line = build(false, inShown, outShown);
    if (line.length <= maxChars) return line;
    if (inShown <= 1 && outShown <= 1) return line.slice(0, maxChars);
    if (inShown >= outShown && inShown > 1) inShown -= 1;
    else outShown -= 1;
  }
}

/** "New booking — 5259 Room 2, Nov 6–9 (Airbnb)." `checkOutExclusive` is the day the guest leaves. */
export function bookingCreatedLine(input: {
  house: string;
  room?: string | null;
  checkIn: string;
  checkOutExclusive: string;
  /** "Airbnb", "Booking.com", "PropLane", or a guest request's own wording. */
  source?: string | null;
  lead?: string;
}): string {
  const place = [input.house.trim(), (input.room ?? "").trim()].filter(Boolean).join(" ");
  const dates = dayRangeLabel(input.checkIn, input.checkOutExclusive);
  const where = [place, dates].filter(Boolean).join(", ");
  const source = input.source?.trim() ? ` (${input.source.trim()})` : "";
  return `${input.lead ?? "New booking"} — ${where}${source}.`;
}

/** "Wed Nov 4 10:00 AM" for an instant, in Pacific time. Empty for an unreadable instant. */
export function pacificMomentLabel(iso: string | null | undefined): string {
  const ms = Date.parse(iso ?? "");
  if (!Number.isFinite(ms)) return "";
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(new Date(ms));
  const get = (type: string) => formatted.find((p) => p.type === type)?.value ?? "";
  const weekday = get("weekday") || WEEKDAYS[new Date(ms).getUTCDay()];
  return `${weekday} ${get("month")} ${get("day")} ${get("hour")}:${get("minute")} ${get("dayPeriod").toUpperCase()}`;
}

/** "Tour requested — Arjun C., 4709A, Wed Nov 4 10:00 AM." / "Tour cancelled — Arjun C., 4709A." */
export function tourAlertLine(kind: "requested" | "cancelled", input: { guest: string; house?: string | null; whenIso?: string | null }): string {
  const when = pacificMomentLabel(input.whenIso);
  const bits = [shortPerson(input.guest), (input.house ?? "").trim(), when].filter(Boolean);
  return `Tour ${kind} — ${bits.join(", ")}.`;
}

/** "Application started — Vaishnavi S., 4709A." */
export function applicationStartedLine(input: { applicant: string; house?: string | null }): string {
  return `Application started — ${[shortPerson(input.applicant), (input.house ?? "").trim()].filter(Boolean).join(", ")}.`;
}

/** The idempotency entity of one house's digest on one Pacific day. */
export function checkinDigestEntityId(propertyId: string, dayKey: string): string {
  return `${propertyId.trim()}:${dayKey.trim()}`;
}
