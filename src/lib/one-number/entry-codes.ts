import { formatUsPhoneDisplay, normalizeE164 } from "@/lib/phone-e164";

/**
 * Entry codes ("Text BROOKLYN5 to (206) 555-0100"): the pure half. A code is the
 * way a stranger on the shared line names a house, so the router matches it as a
 * whole token anywhere in a text. That is why the shape is strict and the word
 * list below is closed: a code that is also an everyday word would hijack texts.
 */

export const ENTRY_CODE_PATTERN = /^[A-Z0-9]{3,16}$/;

/** Carrier and product keywords. A code can never be one: they are handled before any routing. */
export const RESERVED_ENTRY_CODES: ReadonlySet<string> = new Set([
  "STOP", "START", "HELP", "HUMAN", "YES", "NO", "INFO", "CANCEL", "END", "QUIT", "UNSUBSCRIBE", "UNSTOP", "STOPALL", "AGENT",
]);

/** Everyday words a stranger's first text is full of. Routing on one would send strangers to the wrong team. */
const COMMON_WORDS: ReadonlySet<string> = new Set([
  "HELLO", "HEY", "ROOM", "ROOMS", "RENT", "TOUR", "TOURS", "APPLY", "THE", "AND", "FOR", "YOU", "PLEASE", "THANKS", "THANK",
  "OKAY", "TEXT", "MORE", "SEND", "PAY", "PAID", "HOUSE", "HOME", "PERSON", "REPRESENTATIVE", "EMERGENCY",
]);

export type EntryCodeProblem = "invalid_format" | "needs_letter" | "reserved";

export function normalizeEntryCode(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toUpperCase() : "";
}

export function validateEntryCode(raw: unknown): { ok: true; code: string } | { ok: false; error: EntryCodeProblem } {
  const code = normalizeEntryCode(raw);
  if (!ENTRY_CODE_PATTERN.test(code)) return { ok: false, error: "invalid_format" };
  if (RESERVED_ENTRY_CODES.has(code) || COMMON_WORDS.has(code)) return { ok: false, error: "reserved" };
  // An all-digit code would match a phone fragment or a rent figure in an ordinary text.
  if (!/[A-Z]/.test(code)) return { ok: false, error: "needs_letter" };
  return { ok: true, code };
}

export const ENTRY_CODE_PROBLEM_MESSAGE: Record<EntryCodeProblem, string> = {
  invalid_format: "Use 3 to 16 letters or numbers.",
  needs_letter: "Include at least one letter.",
  reserved: "That word is reserved. Pick another.",
};

const DIRECTIONS = new Set(["N", "S", "E", "W", "NE", "NW", "SE", "SW", "NORTH", "SOUTH", "EAST", "WEST"]);
const STREET_SUFFIXES = new Set([
  "AVE", "AVENUE", "ST", "STREET", "RD", "ROAD", "BLVD", "BOULEVARD", "DR", "DRIVE", "LN", "LANE", "WAY", "CT", "COURT", "PL", "PLACE",
  "TER", "TERRACE", "PKWY", "PARKWAY", "CIR", "CIRCLE", "HWY",
]);
const UNIT_MARKERS = new Set(["APT", "UNIT", "STE", "SUITE", "FL", "FLOOR"]);

/** `{ number: "4709A", name: "8THAVE", digits: "4709" }` for "4709A 8th Ave NE, Seattle", or null when there is no street number. */
export function parseStreet(address: string): { number: string; digits: string; word: string } | null {
  const street = String(address ?? "").split(",")[0] ?? "";
  const parts = street.toUpperCase().replace(/[^A-Z0-9# ]+/g, " ").split(/\s+/).filter(Boolean);
  const first = parts.shift();
  if (!first || !/^\d+[A-Z]?$/.test(first)) return null;
  const words: string[] = [];
  for (const part of parts) {
    if (part.startsWith("#") || UNIT_MARKERS.has(part)) break;
    words.push(part);
  }
  while (words.length > 1 && DIRECTIONS.has(words[0]!)) words.shift();
  while (words.length > 1 && DIRECTIONS.has(words[words.length - 1]!)) words.pop();
  if (words.length === 0) return null;
  const ordinal = /^\d/.test(words[0]!);
  const kept = ordinal ? words.slice(0, 2) : words.filter((w, i) => !(i > 0 && STREET_SUFFIXES.has(w)) && !(i === 0 && words.length > 1 && STREET_SUFFIXES.has(w)));
  const word = kept.join("").replace(/[^A-Z0-9]/g, "").slice(0, 11);
  const digits = first.replace(/\D/g, "");
  return word && digits ? { number: first, digits, word } : null;
}

/**
 * Candidate codes for a house, best first: the street word plus the first digit (BROOKLYN5), or the first two when
 * the word is short (8THAVE47); then longer digit runs; then a numeric tail. Reserved and non-conforming ones are dropped.
 */
export function entryCodeCandidates(input: { address?: string | null; label?: string | null }): string[] {
  const parsed = parseStreet(input.address ?? "") ?? parseStreet(input.label ?? "");
  const out: string[] = [];
  const push = (code: string) => {
    const trimmed = code.slice(0, 16);
    if (validateEntryCode(trimmed).ok && !out.includes(trimmed)) out.push(trimmed);
  };
  if (parsed) {
    const lead = parsed.word.length >= 7 ? 1 : 2;
    push(`${parsed.word}${parsed.digits.slice(0, lead)}`);
    push(`${parsed.word}${parsed.digits.slice(0, 2)}`);
    push(`${parsed.word}${parsed.digits.slice(0, 3)}`);
    push(`${parsed.word}${parsed.digits}`);
    for (let n = 2; n <= 9; n += 1) push(`${parsed.word}${parsed.digits.slice(0, lead)}${n}`);
  }
  const fallback = String(input.label ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
  if (fallback) {
    push(fallback);
    for (let n = 2; n <= 9; n += 1) push(`${fallback}${n}`);
  }
  return out;
}

/** "Text BROOKLYN5 to (206) 555-0100". Null until a shared number exists. */
export function entryCodeCallToAction(code: string, sharedNumber: string | null | undefined): string | null {
  const number = normalizeE164(sharedNumber);
  return number ? `Text ${code} to ${formatUsPhoneDisplay(number)}` : null;
}

/** `sms:+12065550100?&body=BROOKLYN5`: the `?&` form opens a prefilled text on both iOS and Android. */
export function entryCodeSmsLink(code: string, sharedNumber: string | null | undefined): string | null {
  const number = normalizeE164(sharedNumber);
  return number ? `sms:${number}?&body=${encodeURIComponent(code)}` : null;
}
