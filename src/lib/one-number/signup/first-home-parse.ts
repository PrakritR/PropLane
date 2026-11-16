/**
 * "Add your first home" by text: reading each answer by CODE (no model). Pure.
 *
 *   address   "4709A 8th Ave, Seattle"        -> a street line with a number
 *   rooms     "3 rooms, $900 each" / "4 rooms $850 $900 $900 $950"
 *   when      "now", "Dec 1", "January 15"
 *   rules     free text (or SKIP)
 *   photos    DONE / SKIP
 */

export type Parsed<T> = { kind: "value"; value: T } | { kind: "skip" } | { kind: "invalid" };

export function isSkipText(text: string): boolean {
  return /^\s*(skip|none|no|nope|n\/a|na|later|pass)\s*[.!]?\s*$/i.test(text);
}

export function isDoneText(text: string): boolean {
  return /^\s*(done|finished|that'?s all|thats all|that is all|all set|no more|that'?s it|thats it)\s*[.!]?\s*$/i.test(text);
}

/** "later" / "not now" at the offer: leave the walkthrough, keep the account. */
export function isLaterText(text: string): boolean {
  return /^\s*(later|not now|not yet|maybe later|no thanks|no thank you|cancel|stop|exit)\s*[.!]?\s*$/i.test(text);
}

export function parseHomeAddressAnswer(text: string): Parsed<string> {
  const t = String(text ?? "").trim().replace(/\s+/g, " ");
  if (t.length < 5 || t.length > 160) return { kind: "invalid" };
  // A street line: a house number and a word. "123 Main St" yes, "my house" no.
  if (!/\b\d{1,6}[a-z]?\b/i.test(t) || !/[a-z]{3,}/i.test(t)) return { kind: "invalid" };
  if (/https?:\/\//i.test(t)) return { kind: "invalid" };
  return { kind: "value", value: t };
}

export type RoomsAndRent = { roomCount: number; rentsUsd: number[] };

const MONEY = /\$\s*(\d{3,5}(?:,\d{3})?(?:\.\d{1,2})?)|\b(\d{3,5})\s*(?:\/\s*(?:mo|month)|a month|per month|each|ea)\b/gi;

export function parseRoomsAndRentAnswer(text: string): Parsed<RoomsAndRent> {
  const t = String(text ?? "").trim();
  if (!t || t.length > 200) return { kind: "invalid" };
  const countMatch = /\b(\d{1,2})\s*(?:rooms?|bedrooms?|br|beds?|bdrm|units?)\b/i.exec(t) ?? /\b(?:rooms?|bedrooms?)\s*[:=]?\s*(\d{1,2})\b/i.exec(t);
  const rents: number[] = [];
  for (const m of t.matchAll(MONEY)) {
    const n = Number(String(m[1] ?? m[2]).replace(/,/g, ""));
    if (Number.isFinite(n)) rents.push(Math.round(n));
  }
  // "3 rooms 900": a bare number after the count is the rent when no money mark was used.
  if (rents.length === 0 && countMatch) {
    const rest = t.replace(countMatch[0], " ");
    for (const m of rest.matchAll(/\b(\d{3,5})\b/g)) rents.push(Number(m[1]));
  }
  const roomCount = countMatch ? Number(countMatch[1]) : rents.length > 1 ? rents.length : 1;
  if (!Number.isInteger(roomCount) || roomCount < 1 || roomCount > 20) return { kind: "invalid" };
  if (rents.length === 0) return { kind: "invalid" };
  if (rents.some((r) => r < 100 || r > 100000)) return { kind: "invalid" };
  if (rents.length !== 1 && rents.length !== roomCount) return { kind: "invalid" };
  return { kind: "value", value: { roomCount, rentsUsd: rents } };
}

const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

export function parseAvailabilityAnswer(text: string): Parsed<string> {
  const t = String(text ?? "").trim().replace(/\s+/g, " ");
  if (isSkipText(t)) return { kind: "skip" };
  if (/\b(now|asap|today|immediately|right away|available)\b/i.test(t) && !new RegExp(`\\b(${MONTHS})\\b`, "i").test(t)) return { kind: "value", value: "Available now" };
  const m = new RegExp(`\\b(${MONTHS})\\.?\\s*(\\d{1,2})(?:st|nd|rd|th)?\\b`, "i").exec(t);
  if (m) return { kind: "value", value: `Available ${m[1]![0]!.toUpperCase()}${m[1]!.slice(1).toLowerCase()} ${Number(m[2])}` };
  const monthOnly = new RegExp(`\\b(${MONTHS})\\b`, "i").exec(t);
  if (monthOnly) return { kind: "value", value: `Available ${monthOnly[1]![0]!.toUpperCase()}${monthOnly[1]!.slice(1).toLowerCase()}` };
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(t);
  if (iso) return { kind: "value", value: `Available ${iso[0]}` };
  return { kind: "invalid" };
}

export function parseRulesAnswer(text: string): Parsed<string> {
  const t = String(text ?? "").trim().replace(/\s+/g, " ");
  if (isSkipText(t)) return { kind: "skip" };
  if (t.length < 3) return { kind: "invalid" };
  if (/https?:\/\//i.test(t)) return { kind: "invalid" };
  return { kind: "value", value: t.slice(0, 400) };
}
