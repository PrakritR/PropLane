/**
 * PropLane Jobs: reading a manager's priced ask by CODE, never by the model.
 *
 *   "need someone to show 4709A Room 3 Saturday 2pm, I'll pay $40"
 *   "I need my rooms cleaned at 5257 this week, $120"
 *
 * The amount, the kind of job, the when and the house hint are all read here from the manager's own words; the posting tool
 * takes the TEXT, so a model can never invent or round a price. Pure (no db, no clock but the one passed in).
 */

export type GigKind = "tour_showing" | "cleaning" | "other";

export type GigAmount =
  | { kind: "none" }
  | { kind: "ambiguous"; amountsCents: number[] }
  | { kind: "too_high"; amountCents: number }
  | { kind: "value"; amountCents: number };

/** A priced job is a small errand. Above this the ask is probably a typo and goes back to the manager. */
export const GIG_MAX_CENTS = 200_000;
export const GIG_MIN_CENTS = 500;

const MONEY_RE = /\$\s*(\d{1,3}(?:,\d{3})+|\d{1,6})(?:\.(\d{1,2}))?/g;
const WORD_MONEY_RE = /\b(\d{1,4})(?:\.(\d{1,2}))?\s*(?:dollars?|bucks|usd)\b/gi;

/** Every dollar figure the text states, in cents. "$40", "$1,200", "40 dollars", "$40.50". Years and street numbers are never read. */
export function readGigAmounts(text: string): number[] {
  const out: number[] = [];
  for (const re of [MONEY_RE, WORD_MONEY_RE]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const dollars = Number(String(m[1]).replace(/,/g, ""));
      const cents = m[2] ? Number(m[2].padEnd(2, "0")) : 0;
      if (Number.isFinite(dollars)) out.push(dollars * 100 + cents);
    }
  }
  return out;
}

export function parseGigAmount(text: string): GigAmount {
  const amounts = [...new Set(readGigAmounts(text))];
  if (amounts.length === 0) return { kind: "none" };
  if (amounts.length > 1) return { kind: "ambiguous", amountsCents: amounts };
  const amountCents = amounts[0]!;
  if (amountCents < GIG_MIN_CENTS || amountCents > GIG_MAX_CENTS) return { kind: "too_high", amountCents };
  return { kind: "value", amountCents };
}

const TOUR_RE = /\b(show(?:ing)?|tours?|walk[- ]?through|open house|host(?:ing)? (?:a )?(?:tour|showing))\b/i;
const CLEAN_RE = /\b(clean(?:ed|ing|er|ers)?|turnover|tidy|vacuum|mop|deep clean)\b/i;

export function readGigKind(text: string): GigKind {
  if (CLEAN_RE.test(text) && !/\bshow(?:ing)?\b.*\bclean/i.test(text)) return "cleaning";
  if (TOUR_RE.test(text)) return "tour_showing";
  return "other";
}

export const GIG_KIND_LABEL: Record<GigKind, string> = { tour_showing: "Tour showing", cleaning: "Cleaning", other: "Odd job" };
/** The board category a kind posts under (`publishServiceToBoard`'s `category`). */
export const GIG_KIND_BOARD_CATEGORY: Record<GigKind, "tours" | "cleaning" | "general"> = { tour_showing: "tours", cleaning: "cleaning", other: "general" };

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const DAY_RE = /\b(today|tonight|tomorrow|this weekend|this week|next week|weekend|sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)\b/i;
const TIME_RE = /\b(1[0-2]|[1-9])(?::([0-5]\d))?\s*(am|pm)\b|\bnoon\b/i;

export type GigWhen = {
  /** The words, tidy: "Saturday 2pm", "this week". Empty when the text names no time. */
  text: string;
  /** A concrete start (UTC ISO) when a day and a time were named, else null. */
  startIso: string | null;
};

function pacificParts(date: Date): { y: number; m: number; d: number; dow: number } {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "numeric", day: "numeric", weekday: "short" }).formatToParts(date);
  const get = (t: string) => f.find((p) => p.type === t)?.value ?? "";
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { y: Number(get("year")), m: Number(get("month")), d: Number(get("day")), dow };
}

/** Pacific wall time -> UTC instant (the offset is read for that very moment, so daylight saving is right). */
export function pacificWallToUtc(y: number, m: number, d: number, hour: number, minute: number): Date {
  const guess = Date.UTC(y, m - 1, d, hour, minute);
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour12: false, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(new Date(guess));
  const get = (t: string) => Number(f.find((p) => p.type === t)?.value ?? 0);
  const asIfUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"));
  return new Date(guess - (asIfUtc - guess));
}

export function readGigWhen(text: string, now: Date): GigWhen {
  const dayMatch = DAY_RE.exec(text);
  const timeMatch = TIME_RE.exec(text);
  const words: string[] = [];
  let dayLabel = "";
  if (dayMatch) {
    dayLabel = dayMatch[1]!;
    words.push(dayLabel.charAt(0).toUpperCase() + dayLabel.slice(1).toLowerCase());
  }
  let hour: number | null = null;
  let minute = 0;
  if (timeMatch) {
    if (/noon/i.test(timeMatch[0])) {
      hour = 12;
      words.push("noon");
    } else {
      const h = Number(timeMatch[1]);
      minute = timeMatch[2] ? Number(timeMatch[2]) : 0;
      const pm = timeMatch[3]!.toLowerCase() === "pm";
      hour = (h % 12) + (pm ? 12 : 0);
      words.push(`${h}${minute ? `:${String(minute).padStart(2, "0")}` : ""}${timeMatch[3]!.toLowerCase()}`);
    }
  }
  const textOut = words.join(" ");
  if (!dayMatch || hour === null) return { text: textOut, startIso: null };

  const today = pacificParts(now);
  const lower = dayLabel.toLowerCase();
  let addDays: number | null = null;
  if (lower === "today" || lower === "tonight") addDays = 0;
  else if (lower === "tomorrow") addDays = 1;
  else {
    const idx = DAYS.findIndex((d) => d.startsWith(lower.slice(0, 3)));
    if (idx >= 0 && !/week/.test(lower)) addDays = (idx - today.dow + 7) % 7 || 7;
  }
  if (addDays === null) return { text: textOut, startIso: null };
  const base = new Date(Date.UTC(today.y, today.m - 1, today.d + addDays));
  const start = pacificWallToUtc(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), hour, minute);
  return { text: textOut, startIso: start.toISOString() };
}

export type GigHomeHint = { streetNumber: string | null; roomLabel: string | null };

/** "4709A Room 3" -> { streetNumber: "4709a", roomLabel: "Room 3" }. Only a hint: the home is always re-derived from the manager's own records. */
export function readGigHomeHint(text: string): GigHomeHint {
  const street = /\b(\d{3,5}[a-z]?)\b(?!\s*(?:am|pm|dollars|bucks))/i.exec(text.replace(/\$\s*[\d,.]+/g, " "));
  const room = /\b(?:room|rm|unit|suite)\b\s*#?\s*([a-z0-9]{1,4})\b/i.exec(text);
  return { streetNumber: street ? street[1]!.toLowerCase() : null, roomLabel: room ? `Room ${room[1]!.toUpperCase()}` : null };
}

/**
 * Does this read as a manager posting a priced job? Needs a request for help AND a price phrase or a "pay" verb, so a
 * bare "clean the kitchen sink" repair report or a rent question is never turned into a posting.
 */
export function looksLikeGigRequest(text: string): boolean {
  const asks = /\b(need|looking for|want|get|find|hire|book)\b[^.?!]{0,40}\b(someone|somebody|anyone|a person|a vendor|a cleaner|a helper|help)\b/i.test(text)
    || /\b(?:i(?:'| wi)?ll pay|will pay|paying|pays?|for \$|\$\d)/i.test(text) && /\b(show|tour|clean|turnover|walk[- ]?through|haul|move|paint|assemble)\w*/i.test(text);
  if (!asks) return false;
  return readGigAmounts(text).length > 0 || /\b(i(?:'| wi)?ll pay|will pay|paying)\b/i.test(text);
}

export type ParsedGig = {
  amount: GigAmount;
  kind: GigKind;
  when: GigWhen;
  home: GigHomeHint;
};

export function parseGigRequest(text: string, now: Date): ParsedGig {
  const clean = String(text ?? "").slice(0, 600);
  return { amount: parseGigAmount(clean), kind: readGigKind(clean), when: readGigWhen(clean, now), home: readGigHomeHint(clean) };
}

export function formatGigUsd(cents: number): string {
  const dollars = cents / 100;
  return `$${dollars.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(dollars) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/* ------------------------------------------------------------------------------------------ */
/* A vendor's reply to an offer                                                               */
/* ------------------------------------------------------------------------------------------ */

export type GigReply = { action: "accept" | "decline"; code: string | null };

/** Unambiguous letters and digits: no 0/O, 1/I/L. */
export const GIG_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const GIG_CODE_RE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/;

/** "YES", "yes K7Q2", "accept", "I'll take it", "NO", "pass K7Q2". A bare word is only a reply when the caller knows an offer is open. */
export function parseGigReply(body: string): GigReply | null {
  const text = String(body ?? "").trim().replace(/[.!]+$/, "");
  if (!text || text.length > 40) return null;
  const m = /^(yes|y|yep|yeah|accept|i(?:'| wi)?ll take it|take it|no|n|nope|pass|decline)(?:\s+#?([a-z0-9]{4}))?$/i.exec(text);
  if (!m) return null;
  const code = m[2] ? m[2].toUpperCase() : null;
  if (code && !GIG_CODE_RE.test(code)) return null;
  const word = m[1]!.toLowerCase();
  return { action: /^(no|n|nope|pass|decline)$/.test(word) ? "decline" : "accept", code };
}

export function newGigCode(random: () => number = Math.random): string {
  let out = "";
  for (let i = 0; i < 4; i += 1) out += GIG_CODE_ALPHABET[Math.floor(random() * GIG_CODE_ALPHABET.length)];
  return out;
}
