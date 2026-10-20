/**
 * The text a resident gets for a rent reminder. Pure.
 *
 * The reminder body is written for email (a greeting, a blank line, a "How to sign in" block). A text
 * keeps the first part, in one line of prose, then ONE link on its own line. It is cut on a word
 * boundary so it fits two billed segments, after the link, and it is made GSM-7 first (a curly quote
 * or a long dash would turn the whole text into UCS-2 and halve the room).
 */
import { toGsm7 } from "@/lib/one-number/segments";
import { estimateSmsSegments } from "@/lib/sms/number-registration-policy";
import { formatSmsLinks } from "@/lib/sms/link-format";

/** Two multipart GSM-7 segments. A reminder that cannot fit in two is shortened, not sent long. */
export const RENT_REMINDER_MAX_UNITS = 306;
const SIGN_IN_MARKER = /how to sign in to proplane/i;
/** The label that introduces the link line. Ends in a colon, so the link below it reads as its answer. */
export const PAY_LINK_LABEL = "Pay here:";

/** `{pay_link}` / `{payLink}` filled with a real address (or removed with its label when there is none). */
export function fillPayLinkToken(text: string, payLink: string | null): string {
  const filled = payLink ? payLink : "";
  const out = String(text ?? "").replace(/\{pay_?link\}/gi, filled);
  return payLink ? out : out.replace(/[ \t]*(?:pay(?: it)? (?:here|now|online)|pay link)[:\s]*$/gim, "").replace(/\n{3,}/g, "\n\n");
}

export function textUsesPayLinkToken(text: string): boolean {
  return /\{pay_?link\}/i.test(String(text ?? ""));
}

/** The reminder prose for a text: no sign-in block, one line, GSM-7. */
export function smsReminderLead(text: string): string {
  const source = String(text ?? "");
  const marker = SIGN_IN_MARKER.exec(source);
  const cut = marker ? source.slice(0, marker.index) : source;
  return toGsm7(cut.replace(/\{pay_?link\}/gi, ""))
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    // A template that said "Pay here: {pay_link}" leaves its label behind; the link line brings its own.
    .replace(/\s*\b(?:pay(?:ment)?(?: link| here| now| online| in proplane)?|link)\s*:\s*$/i, "")
    .trim();
}

const units = (s: string) => estimateSmsSegments(s).encodedUnits;

/** Cut `text` on a word boundary so that it is at most `maxUnits` GSM-7 units, ending in "..." when shortened. */
export function truncateOnWord(text: string, maxUnits: number): string {
  const clean = String(text ?? "").trim();
  if (units(clean) <= maxUnits) return clean;
  const ellipsis = "...";
  const budget = Math.max(maxUnits - ellipsis.length, 0);
  let kept = "";
  for (const word of clean.split(/\s+/)) {
    const next = kept ? `${kept} ${word}` : word;
    if (units(next) > budget) break;
    kept = next;
  }
  // A single word longer than the room is cut by characters rather than sent whole.
  if (!kept) kept = clean.slice(0, budget);
  return `${kept.replace(/[\s,;:.\-]+$/, "")}${ellipsis}`;
}

/**
 * The finished reminder text: the lead, then the label and the link each on their own line, within two
 * segments. `payLink` is null when the resident has no way to be sent one (the caller then sends no link).
 */
export function composeRentReminderSms(input: {
  text: string;
  payLink: string | null;
  canonicalOrigin: string;
  maxUnits?: number;
}): string {
  const max = input.maxUnits ?? RENT_REMINDER_MAX_UNITS;
  const lead = smsReminderLead(input.text);
  if (!input.payLink) return truncateOnWord(lead, max);
  const link = formatSmsLinks(input.payLink, input.canonicalOrigin);
  const tail = `\n${PAY_LINK_LABEL}\n${link}`;
  const room = max - units(tail);
  const body = truncateOnWord(lead, Math.max(room, 40));
  return formatSmsLinks(`${body}${tail}`, input.canonicalOrigin);
}
