/**
 * Every text the dispatch engine composes (vendor-dispatch-1018). Pure, no I/O,
 * so the privacy rules are testable in one place:
 *  - a vendor who has only been OFFERED a job reads the general area, never the
 *    street address (`docs/agents/services-system.md`); the address goes out in
 *    the confirmation text after they accept;
 *  - a resident's phone or email never appears in a vendor-facing text, and a
 *    person is a first name only;
 *  - one GSM-7 segment where possible (no emoji, curly quotes or long dashes).
 */

import { MAX_PICK_POSITION } from "@/lib/vendor-dispatch/reply-parse";

export const SMS_SEGMENT_CHARS = 160;
/** A segment of a MULTI-part GSM-7 message: six characters of each one carry the concatenation header. */
export const SMS_CONCAT_SEGMENT_CHARS = 153;

const GSM_REPLACEMENTS: Array<[RegExp, string]> = [
  [/[‘’‛]/g, "'"],
  [/[“”‟]/g, '"'],
  [/[–—―−]/g, "-"],
  [/…/g, "..."],
  [/ /g, " "],
  [/[·•]/g, "-"],
];

/** Plain-ASCII, one-line SMS text. Anything outside printable ASCII is dropped. */
export function toGsm7(value: string): string {
  let text = String(value ?? "");
  for (const [pattern, replacement] of GSM_REPLACEMENTS) text = text.replace(pattern, replacement);
  return text
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const PHONE_PATTERN = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/g;

/** Strip anything that identifies a person's contact details out of vendor-facing free text. */
export function stripContactDetails(value: string): string {
  return String(value ?? "")
    .replace(EMAIL_PATTERN, "")
    .replace(PHONE_PATTERN, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Street addresses as free text writes them: a house number followed by a street name and a type word, with an
 * optional directional either side ("5259 Brooklyn Ave NE", "42 S Alder St, Unit 2").
 */
const STREET_ADDRESS_PATTERN =
  /\b\d{1,6}\s+(?:[NSEW]{1,2}\.?\s+)?(?:[A-Za-z0-9'.-]+\s+){0,3}(?:st|street|ave|avenue|av|rd|road|blvd|boulevard|dr|drive|ln|lane|way|ct|court|pl|place|ter|terrace|pkwy|parkway|hwy|highway|cir|circle|trl|trail)\b\.?(?:\s*,?\s*(?:[NSEW]{1,2})\b\.?)?(?:\s*,?\s*(?:apt|apartment|unit|ste|suite|rm|room|#)\s*[A-Za-z0-9-]+)?/gi;

/**
 * The SUFFIXLESS form this product writes its own houses in: a house number (optionally with a unit letter) and the
 * street name alone - "5259 Brooklyn", "4709A 8th", "412 Pine". The pattern above needs a type word (St, Ave), so
 * none of those were stripped, and a resident titling a request "Leak at 5259 Brooklyn" sent the address to every
 * vendor who had only been offered the job.
 *
 * Three digits minimum, and the following token must read like a street name (capitalised, or an ordinal such as
 * `8th`), so a count or a measurement in ordinary free text survives: "2 people", "fix 3 windows", "100 feet of
 * pipe", "room 3". A directional may lead the name ("4100 NE 45th").
 */
const HOUSE_NUMBER_PATTERN =
  /\b\d{3,6}[A-Za-z]?\s+(?:[NSEW]{1,2}\.?\s+)?(?:\d{1,3}(?:st|nd|rd|th)|[A-Z][A-Za-z'.-]*)(?:\s+(?:\d{1,3}(?:st|nd|rd|th)|[A-Z][A-Za-z'.-]*)){0,2}\b/g;

/** Strip anything that reads as a street address: an OFFERED vendor is told the general area and never the street. */
export function stripStreetAddresses(value: string): string {
  return String(value ?? "").replace(STREET_ADDRESS_PATTERN, "").replace(HOUSE_NUMBER_PATTERN, "");
}

/** Longest first, so removing "5259 Brooklyn" cannot leave the tail of "5259 Brooklyn Ave NE" behind. */
function escapeLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Remove the run's OWN place strings verbatim, case-insensitively: the exact buildingName and address this job is
 * at. A pattern can only guess at what reads like an address, but these are the strings in hand, so whatever shape
 * the house is written in ("The Brooklyn", "Unit B - 4709A 8th"), a title that repeats it is cleaned.
 */
function stripKnownPlaces(value: string, places: readonly string[]): string {
  let text = value;
  const unique = [...new Set(places.map((place) => String(place ?? "").trim()).filter((place) => place.length >= 3))]
    .sort((a, b) => b.length - a.length);
  for (const place of unique) {
    text = text.replace(new RegExp(escapeLiteral(place), "gi"), "");
  }
  return text;
}

/**
 * The one sanitizer for vendor-facing free text, whoever wrote it (a resident's title and description, a model's
 * summary): no phone, no email, no street address. Every field that reaches a vendor's offer text or the
 * vendor-portal board goes through this.
 *
 * `knownPlaces` are the job's own house strings (buildingName, address, the street line), removed verbatim before
 * the patterns run - the caller already loaded the house, so the exact strings to take out are known rather than
 * guessed.
 */
export function sanitizeVendorFacingText(value: string, knownPlaces: readonly string[] = []): string {
  const withoutPlaces = stripKnownPlaces(String(value ?? ""), knownPlaces);
  return stripStreetAddresses(stripContactDetails(withoutPlaces))
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([,;:-])\s*(?=[,;:.])/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,;:.*-]+/, "")
    .replace(/[\s,;:-]+$/, "")
    .replace(/\s+(?:at|in|on|for)\s*$/i, "")
    .trim();
}

export function firstNameOf(value: string | null | undefined): string {
  const first = String(value ?? "").trim().split(/\s+/)[0] ?? "";
  return first.replace(/[^A-Za-z'-]/g, "");
}

export function formatDollars(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

/** Fit `text` to `max` characters, cutting at a word boundary. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, Math.max(0, max)).replace(/\s+\S*$/, "");
  return (cut || text.slice(0, max)).trim();
}

export type DispatchJobDetails = {
  /** What the job is, e.g. "Lockout", "Turnover clean", "Prospect tour". */
  what?: string;
  /** The vendor-facing general area ("Capitol Hill", "Seattle"). Never a street address. */
  area?: string;
  /** The house as the manager reads it, e.g. "5259 Brooklyn". Manager-facing only. */
  houseLabel?: string;
  /** Full street address. Sent to a vendor only AFTER they accept. */
  address?: string;
  room?: string;
  /** When it should happen, as a short label ("now", "Fri 2pm"). */
  whenLabel?: string;
  /** ISO start of a fixed-time job (a tour). */
  startIso?: string;
  durationMinutes?: number;
  /** Cleaning turnovers: the next check-in. */
  deadlineLabel?: string;
  deadlineIso?: string;
  /** First name only: the resident or the prospect. */
  personFirstName?: string;
  /** Entry method the resident gave, shared after acceptance. */
  entryNote?: string;
  /** Free text from the resident. Contact details are stripped before it reaches a vendor. */
  summary?: string;
};

export type PayLabelInput = { payCents?: number | null; payModel?: string | null };

export function payLabel(input: PayLabelInput): string {
  if (input.payCents != null && input.payCents > 0 && input.payModel !== "quote") {
    const suffix = input.payModel === "hourly" ? "/hr" : input.payModel === "per_room" ? "/room" : "";
    return `${formatDollars(input.payCents)}${suffix}`;
  }
  return "quote";
}

/**
 * The text a vendor reads when offered a job. `handle` is the short run number
 * the vendor can echo back ("YES 7") when several offers are open at once.
 */
export function composeVendorOfferText(input: {
  handle: number;
  details: DispatchJobDetails;
  payCents?: number | null;
  payModel?: string | null;
  deadlineLabel?: string | null;
}): string {
  const d = input.details;
  const what = toGsm7(d.what || "Job");
  const area = toGsm7(d.area || "");
  const where = [area, d.room ? toGsm7(d.room) : ""].filter(Boolean).join(" ");
  const person = d.personFirstName ? ` for ${toGsm7(d.personFirstName)}` : "";
  const when = d.whenLabel ? toGsm7(d.whenLabel) : "";
  const length = d.durationMinutes ? `${d.durationMinutes} min` : "";
  const deadline = input.deadlineLabel || d.deadlineLabel ? `done by ${toGsm7(String(input.deadlineLabel || d.deadlineLabel))}` : "";
  const pay = payLabel(input);
  const payPart = pay === "quote" ? "Pay: your quote" : `Pay ${pay}`;

  const head = `PropLane job #${input.handle}: ${what}${where ? ` in ${where}` : ""}${person}`;
  const detailParts = [when, length, deadline].filter(Boolean);
  const tail = `${payPart}. Reply YES, NO or BUSY 2h`;
  const text = toGsm7(`${[head, ...detailParts].join(", ")}. ${tail}`);
  if (text.length <= SMS_SEGMENT_CHARS) return text;
  // Over one segment: drop the least important parts first, then clip the head.
  const compact = toGsm7(`${[`#${input.handle} ${what}${area ? ` in ${area}` : ""}`, ...detailParts].join(", ")}. ${payPart}. YES/NO/BUSY`);
  if (compact.length <= SMS_SEGMENT_CHARS) return compact;
  return clip(compact, SMS_SEGMENT_CHARS);
}

/**
 * The manager approval text, one segment:
 * `Lockout 5259 Brooklyn R3 #7. Send Sam Locksmith $120, then Lee, Kim if busy? Y/N or 1-3 to pick one`
 *
 * `instruction` REPLACES the plain "Y/N or 1-3 to pick one" clause (the PropLane line's coded line, which is the
 * only form that works there). An ask carries ONE instruction: two would leave the manager reading a form their
 * reply is refused for. The instruction is never clipped, and the body is fitted to what is left of the budget -
 * two segments with an instruction, since the code line cannot share one with the job.
 */
export function composeApprovalText(input: {
  handle: number;
  what: string;
  houseLabel: string;
  room?: string | null;
  vendorNames: string[];
  payCents?: number | null;
  payModel?: string | null;
  mode: "sequential" | "broadcast";
  instruction?: string | null;
}): string {
  const names = input.vendorNames.map((name) => toGsm7(name)).filter(Boolean);
  const pay = payLabel(input);
  const payPart = pay === "quote" ? "" : ` ${pay}`;
  const where = toGsm7([input.houseLabel, input.room ?? ""].filter(Boolean).join(" "));
  const head = (house: string) => `${toGsm7(input.what)} ${house} #${input.handle}.`;
  const [first, ...rest] = names;
  const coded = input.instruction ? toGsm7(input.instruction) : null;
  const pickable = Math.min(names.length, MAX_PICK_POSITION);
  const pick = coded ? "" : names.length > 1 ? ` Y/N or 1-${pickable} to pick one` : " Y/N";
  const build = (house: string, backups: string): string => {
    if (!first) return `${head(house)} No vendor on file.${coded ? "" : " Reply N"}`;
    const target = input.mode === "broadcast" && names.length > 1 ? `${names.join(", ")} at once` : `${first}${payPart}`;
    return `${head(house)} Send ${target}${backups}?${pick}`;
  };
  const backupsFull = input.mode === "sequential" && rest.length > 0 ? `, then ${rest.join(", ")} if busy` : "";
  const attempts = [
    build(where, backupsFull),
    build(where, input.mode === "sequential" && rest.length > 0 ? `, then ${rest.length} backup${rest.length === 1 ? "" : "s"}` : ""),
    build(clip(where, 22), input.mode === "sequential" && rest.length > 0 ? `, +${rest.length}` : ""),
  ];
  const suffix = coded ? ` ${coded}` : "";
  const bodyBudget = (coded ? SMS_CONCAT_SEGMENT_CHARS * 2 : SMS_SEGMENT_CHARS) - suffix.length;
  for (const attempt of attempts) {
    const text = toGsm7(attempt);
    if (text.length <= bodyBudget) return `${text}${suffix}`;
  }
  return `${clip(toGsm7(attempts[2]!), bodyBudget)}${suffix}`;
}

export function composeQuoteAskText(input: { handle: number; vendorName: string; quoteCents: number; capCents: number | null; instruction?: string | null }): string {
  const cap = input.capCents != null ? ` (cap ${formatDollars(input.capCents)})` : "";
  const answer = input.instruction ? toGsm7(input.instruction) : "Y/N";
  return toGsm7(`${firstNameOf(input.vendorName) || "Vendor"} quotes ${formatDollars(input.quoteCents)}${cap} #${input.handle}. ${answer}`);
}

export function composeManagerAcceptedText(input: { handle: number; vendorName: string; whenLabel?: string | null }): string {
  const when = input.whenLabel ? `, ~${toGsm7(input.whenLabel)}` : "";
  return toGsm7(`${firstNameOf(input.vendorName) || "Vendor"} accepted${when} #${input.handle}`);
}

export function composeExhaustedText(input: { handle: number; tradeLabel: string; instruction?: string | null }): string {
  const trade = `${input.tradeLabel.toLowerCase()}s`;
  if (input.instruction) {
    return toGsm7(`No one took #${input.handle}. R retries, B offers all ${trade} at once. ${input.instruction}, or handle it yourself`);
  }
  return toGsm7(`No one took #${input.handle}. R to retry, B to offer all ${trade} at once, or handle it yourself`);
}

export function composeVendorTakenText(handle: number): string {
  return `Job #${handle} was taken. Thanks for the quick reply`;
}

export function composeVendorDeclinedAck(handle: number): string {
  return `Got it, #${handle} passed on. Thanks`;
}

export function composeVendorBusyAck(handle: number, minutes: number): string {
  const label = minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
  return `Got it, #${handle} passed and we will not text you for ${label}`;
}

/** After acceptance the vendor gets the address and entry details, never a resident phone or email. */
export function composeVendorConfirmText(input: { handle: number; details: DispatchJobDetails; whenLabel?: string | null }): string {
  const d = input.details;
  const where = toGsm7([d.address || d.houseLabel || d.area || "", d.room ?? ""].filter(Boolean).join(" "));
  const entry = d.entryNote ? ` Entry: ${toGsm7(stripContactDetails(d.entryNote))}.` : "";
  const when = input.whenLabel ? ` ${toGsm7(input.whenLabel)}.` : "";
  const text = toGsm7(`#${input.handle} confirmed.${when} ${where}.${entry} Reply DONE when finished`);
  return clip(text, 320);
}

export function composeVendorQuoteHeldText(handle: number): string {
  return `Thanks, #${handle}: checking your price with the manager. We will text you shortly`;
}

export function composeVendorQuoteDeclinedText(handle: number): string {
  return `Thanks, #${handle} will go another way this time`;
}

export function composeResidentAcceptedText(input: { vendorName: string; tradeLabel: string; whenLabel?: string | null }): string {
  const who = firstNameOf(input.vendorName) || input.tradeLabel;
  const when = input.whenLabel ? ` around ${toGsm7(input.whenLabel)}` : " soon";
  return toGsm7(`${who} (${input.tradeLabel.toLowerCase()}) is coming${when}.`);
}

export function composeResidentFixedAsk(): string {
  return "Your service is done. Is it fixed? Reply YES or NO";
}

export function composeManagerNotFixedText(input: { handle: number; houseLabel: string }): string {
  return toGsm7(`Resident says #${input.handle} at ${input.houseLabel} is NOT fixed. Service reopened`);
}

export function composeManagerDoneText(input: { handle: number; vendorName: string }): string {
  return toGsm7(`${firstNameOf(input.vendorName) || "Vendor"} finished #${input.handle}. Asked the resident to confirm`);
}

export function composeInvoiceAskText(input: { handle: number; vendorName: string; cents: number; instruction?: string | null }): string {
  const answer = input.instruction ? toGsm7(input.instruction) : "Y/N";
  return toGsm7(`${firstNameOf(input.vendorName) || "Vendor"} invoiced ${formatDollars(input.cents)} for #${input.handle}. ${answer}`);
}
