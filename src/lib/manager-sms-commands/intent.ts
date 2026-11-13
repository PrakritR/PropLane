/**
 * Manager text intents (design-1112 section 3.3). Pure rules, no model, no I/O: a text either matches one of the few
 * shapes below or it is left to the manager agent. The words that name WHICH house or room stay in `targetText`;
 * `resolve-target.ts` turns them into a catalog record or a one-line question.
 */

export type EditIntent =
  | { kind: "edit"; field: "rent"; rentUsd: number; targetText: string }
  | { kind: "edit"; field: "available"; availableOn: string; targetText: string }
  | { kind: "edit"; field: "description"; text: string; mode: "replace" | "append"; targetText: string };

export type ManagerIntent =
  | EditIntent
  | { kind: "start_listing" }
  | { kind: "cancel" }
  | { kind: "confirmation" }
  | { kind: "none" };

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

const pad = (n: number) => String(n).padStart(2, "0");

/** YYYY-MM-DD of the local calendar day. */
export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function realDate(y: number, m: number, d: number): boolean {
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

/** A year-less date is the next one on or after today, never a day already past. */
function inferYear(m: number, d: number, today: Date): number | null {
  const y = today.getFullYear();
  if (!realDate(y, m, d)) return null;
  return dayKey(new Date(y, m - 1, d)) >= dayKey(today) ? y : realDate(y + 1, m, d) ? y + 1 : null;
}

export type FoundDate = { availableOn: string; start: number; end: number };

/** "now", "dec 1", "December 1st", "12/1", "12/1/2026", "2026-12-01". Null when nothing reads as one date. */
export function findDate(text: string, today: Date = new Date()): FoundDate | null {
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  if (iso) {
    const [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    return realDate(y, m, d) ? { availableOn: `${y}-${pad(m)}-${pad(d)}`, start: iso.index, end: iso.index + iso[0].length } : null;
  }
  const named = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/i.exec(text);
  if (named) {
    const m = MONTHS[named[1]!.toLowerCase()]!;
    const d = Number(named[2]);
    const y = named[3] ? Number(named[3]) : inferYear(m, d, today);
    if (y && realDate(y, m, d)) return { availableOn: `${y}-${pad(m)}-${pad(d)}`, start: named.index, end: named.index + named[0].length };
    return null;
  }
  const slash = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(text);
  if (slash) {
    const m = Number(slash[1]);
    const d = Number(slash[2]);
    let y: number | null;
    if (slash[3]) {
      y = Number(slash[3]);
      if (y < 100) y += 2000;
    } else y = inferYear(m, d, today);
    if (y && realDate(y, m, d)) return { availableOn: `${y}-${pad(m)}-${pad(d)}`, start: slash.index, end: slash.index + slash[0].length };
    return null;
  }
  const now = /\b(?:now|today|immediately|right away)\b/i.exec(text);
  if (now) return { availableOn: "now", start: now.index, end: now.index + now[0].length };
  return null;
}

export type FoundAmount = { rentUsd: number; start: number; end: number };

const AMOUNT = /\$\s*(\d{1,3}(?:,\d{3})+|\d{2,6})(?:\.\d{1,2})?|\b(\d{1,3}(?:,\d{3})+|\d{3,6})(?:\.\d{1,2})?\b/g;

/**
 * The rent in a text. A "$" wins; else the amount after "to" / "rent" / "price"; else the last number. A street number
 * such as "5259" is also a number, which is why those anchors exist.
 */
export function findAmount(text: string): FoundAmount | null {
  const all: FoundAmount[] = [];
  for (const m of text.matchAll(AMOUNT)) {
    const raw = (m[1] ?? m[2] ?? "").replace(/,/g, "");
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 100 || value > 100000) continue;
    all.push({ rentUsd: Math.round(value), start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  if (all.length === 0) return null;
  const dollar = all.find((a) => text.slice(a.start, a.end).includes("$"));
  if (dollar) return dollar;
  const anchored = all.find((a) => /(?:\bto|\brent|\bprice|\brate|=|:)\s*$/i.test(text.slice(0, a.start)));
  if (anchored) return anchored;
  return all[all.length - 1]!;
}

const QUESTION_START = /^(?:what|what's|whats|how|when|who|which|where|why|is|are|does|do|can|could|did|show|list|tell|send|text|email|call|remind)\b/i;
const CONFIRM_WORDS = /^(?:yes|y|yep|yeah|no|n|nope|ok|okay|confirm|confirmed|approve|approved|cancel it|thanks|thank you)[\s.!]*(?:\d{4})?[\s.!]*$/i;
const START_LISTING = /^(?:new|another)\s+(?:listing|house|property|place|home)(?:\s+(?:for|at)\s+[^?]*)?[\s.!]*$|^(?:please\s+)?(?:(?:i\s+(?:want|need)\s+to\s+)|(?:let'?s\s+))?(?:create|start|make|build|add|post|list)\s+(?:a\s+|an\s+|my\s+)?(?:new\s+)?(?:listing|house|property|place|home|room)s?\b[^?]*$/i;
const CANCEL = /^(?:cancel|never\s*mind|nevermind|quit|abort|start over)[\s.!]*$/i;

const AVAILABLE_WORD = /\b(?:avail(?:able|ability)?|vacant|opens?(?:\s+up)?\s+(?:on|from)|move[- ]in(?:\s+date)?|ready\s+(?:on|from))\b/i;
const DESCRIPTION_WORD = /\b(?:description|describe|desc)\b/i;
const RENT_WORD = /\b(?:rent|price|rate)\b/i;
const CHANGE_VERB = /\b(?:change|set|make|update|raise|lower|drop|reduce|increase|bump|adjust)\b/i;

function stripSpans(text: string, spans: Array<{ start: number; end: number }>): string {
  let out = text;
  for (const span of [...spans].sort((a, b) => b.start - a.start)) out = `${out.slice(0, span.start)} ${out.slice(span.end)}`;
  return out.replace(/\s+/g, " ").trim();
}

/** Read one text. `today` is injectable so a test pins the calendar. */
export function parseManagerIntent(rawBody: string, today: Date = new Date()): ManagerIntent {
  const body = String(rawBody ?? "").trim();
  if (!body) return { kind: "none" };
  if (CONFIRM_WORDS.test(body)) return { kind: "confirmation" };
  if (CANCEL.test(body)) return { kind: "cancel" };
  if (START_LISTING.test(body)) return { kind: "start_listing" };
  if (body.endsWith("?") || QUESTION_START.test(body)) return { kind: "none" };

  if (DESCRIPTION_WORD.test(body)) {
    const colon = body.indexOf(":");
    let text = "";
    let head = body;
    if (colon > 0) {
      text = body.slice(colon + 1).trim();
      head = body.slice(0, colon);
    } else {
      const lead = /\b(?:description|describe|desc)\b(?:\s+(?:for|of|on|at))?\s+/i.exec(body);
      const quoted = /["“]([^"”]{3,})["”]\s*$/.exec(body);
      const to = /\s(?:to say|to read|to|says?|as)\s+(.+)$/i.exec(body);
      if (quoted) {
        text = quoted[1]!.trim();
        head = body.slice(0, quoted.index);
      } else if (to) {
        text = to[1]!.trim();
        head = body.slice(0, to.index);
      } else if (lead && lead.index !== undefined) {
        head = body.slice(0, lead.index);
        text = "";
      }
    }
    if (!text) return { kind: "none" };
    const mode = /\badd(?:ing)?\b|\bappend\b/i.test(head) ? "append" : "replace";
    const targetText = head.replace(/\b(?:the|please|add|append|update|change|set|description|describe|desc|detail|details|to|for|of|on)\b/gi, " ").replace(/\s+/g, " ").trim();
    return { kind: "edit", field: "description", text: text.slice(0, 1200), mode, targetText };
  }

  if (AVAILABLE_WORD.test(body)) {
    const date = findDate(body, today);
    if (!date) return { kind: "none" };
    return { kind: "edit", field: "available", availableOn: date.availableOn, targetText: stripSpans(body, [date]) };
  }

  const amount = findAmount(body);
  if (amount && (RENT_WORD.test(body) || (CHANGE_VERB.test(body) && /\bto\b/i.test(body)) || /\$/.test(body))) {
    return { kind: "edit", field: "rent", rentUsd: amount.rentUsd, targetText: stripSpans(body, [amount]) };
  }
  return { kind: "none" };
}

/** Reply handle shape: "K7 yes Dec 1 works". Whether the handle is LIVE is the server's question. */
export function parseRelayShape(rawBody: string): { handle: string; message: string } | null {
  const m = /^\s*([A-Za-z][A-Za-z0-9]{1,3})[\s:,-]+([\s\S]+?)\s*$/.exec(String(rawBody ?? ""));
  if (!m) return null;
  const handle = m[1]!.toUpperCase();
  // A minted handle always carries a digit ("K7"), so an ordinary first word is never read as a (wrong) handle.
  if (!/\d/.test(handle) || RESERVED_HANDLES.has(handle)) return null;
  const message = m[2]!.trim();
  return message ? { handle, message: message.slice(0, 1600) } : null;
}

/** Words a handle can never be, so "YES 4821" and a carrier keyword are never read as a relay. */
export const RESERVED_HANDLES = new Set([
  "YES", "NO", "STOP", "START", "HELP", "OK", "Y", "N", "CANCEL", "QUIT", "END", "UNSTOP", "INFO", "THE", "AND", "HI", "HEY",
]);
