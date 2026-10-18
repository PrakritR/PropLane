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

export const SMS_SEGMENT_CHARS = 160;

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
}): string {
  const names = input.vendorNames.map((name) => toGsm7(name)).filter(Boolean);
  const pay = payLabel(input);
  const payPart = pay === "quote" ? "" : ` ${pay}`;
  const where = toGsm7([input.houseLabel, input.room ?? ""].filter(Boolean).join(" "));
  const head = (house: string) => `${toGsm7(input.what)} ${house} #${input.handle}.`;
  const [first, ...rest] = names;
  const pick = names.length > 1 ? ` Y/N or 1-${names.length} to pick one` : " Y/N";
  const build = (house: string, backups: string): string => {
    if (!first) return `${head(house)} No vendor on file. Reply N`;
    const target = input.mode === "broadcast" && names.length > 1 ? `${names.join(", ")} at once` : `${first}${payPart}`;
    return `${head(house)} Send ${target}${backups}?${pick}`;
  };
  const backupsFull = input.mode === "sequential" && rest.length > 0 ? `, then ${rest.join(", ")} if busy` : "";
  const attempts = [
    build(where, backupsFull),
    build(where, input.mode === "sequential" && rest.length > 0 ? `, then ${rest.length} backup${rest.length === 1 ? "" : "s"}` : ""),
    build(clip(where, 22), input.mode === "sequential" && rest.length > 0 ? `, +${rest.length}` : ""),
  ];
  for (const attempt of attempts) {
    const text = toGsm7(attempt);
    if (text.length <= SMS_SEGMENT_CHARS) return text;
  }
  return clip(toGsm7(attempts[2]!), SMS_SEGMENT_CHARS);
}

export function composeQuoteAskText(input: { handle: number; vendorName: string; quoteCents: number; capCents: number | null }): string {
  const cap = input.capCents != null ? ` (cap ${formatDollars(input.capCents)})` : "";
  return toGsm7(`${firstNameOf(input.vendorName) || "Vendor"} quotes ${formatDollars(input.quoteCents)}${cap} #${input.handle}. Y/N`);
}

export function composeManagerAcceptedText(input: { handle: number; vendorName: string; whenLabel?: string | null }): string {
  const when = input.whenLabel ? `, ~${toGsm7(input.whenLabel)}` : "";
  return toGsm7(`${firstNameOf(input.vendorName) || "Vendor"} accepted${when} #${input.handle}`);
}

export function composeExhaustedText(input: { handle: number; tradeLabel: string }): string {
  return toGsm7(
    `No one took #${input.handle}. R to retry, B to offer all ${input.tradeLabel.toLowerCase()}s at once, or handle it yourself`,
  );
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

export function composeInvoiceAskText(input: { handle: number; vendorName: string; cents: number }): string {
  return toGsm7(`${firstNameOf(input.vendorName) || "Vendor"} invoiced ${formatDollars(input.cents)} for #${input.handle}. Y/N`);
}
