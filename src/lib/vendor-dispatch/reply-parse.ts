/**
 * Deterministic parsing of the replies the dispatch loop expects, run BEFORE
 * any AI agent sees the text (vendor-dispatch-1018). Pure.
 *
 * Manager: `Y`, `YES`, `Y 7`, `N 7`, `2`, `2 7`, `R 7` (retry), `B 7` (offer all), each with the PropLane line's
 *           4-digit confirmation code where one is required (`Y 4821`, `Y 7 4821`).
 * Vendor:  `YES [time] [$price]`, `NO`, `BUSY [2h]`, `DONE`, each with an optional job number.
 * Anything else is "not ours" and falls through to the normal agents.
 */

/**
 * `code` is the 4-digit confirmation code a manager phone must repeat on the PropLane line ("Y 7 4821"). With only
 * one number in the reply the two readings are ambiguous ("Y 4821" is a handle on any other line), so the number is
 * reported as BOTH: `handle` as before, and `codeCandidate` with its leading zeros intact. The handler resolves it -
 * a number that names an open job is a handle, otherwise it is the code for the one job waiting.
 */
export type ManagerDispatchReplyBase = { handle: number | null; code: string | null; codeCandidate: string | null };

export type ManagerDispatchReply =
  | ({ kind: "approve" } & ManagerDispatchReplyBase)
  | ({ kind: "decline" } & ManagerDispatchReplyBase)
  | ({ kind: "pick"; position: number } & ManagerDispatchReplyBase)
  | ({ kind: "retry" } & ManagerDispatchReplyBase)
  | ({ kind: "broadcast" } & ManagerDispatchReplyBase);

const MANAGER_REPLY = /^\s*(?:(y|yes)|(n|no)|(\d)|(r|retry)|(b|broadcast))\s*(?:[#\s]\s*(\d{1,6}))?\s*(?:[#\s]\s*(\d{4}))?\s*[.!]?\s*$/i;

export function parseManagerDispatchReply(body: string): ManagerDispatchReply | null {
  const match = MANAGER_REPLY.exec(String(body ?? ""));
  if (!match) return null;
  const handle = match[6] ? Number(match[6]) : null;
  const code = match[7] ?? null;
  const codeCandidate = code ?? (match[6] && match[6].length === 4 ? match[6] : null);
  const base = { handle, code, codeCandidate };
  if (match[1]) return { kind: "approve", ...base };
  if (match[2]) return { kind: "decline", ...base };
  if (match[3]) {
    const position = Number(match[3]);
    return position >= 1 ? { kind: "pick", position, ...base } : null;
  }
  if (match[4]) return { kind: "retry", ...base };
  return { kind: "broadcast", ...base };
}

export type VendorDispatchReply =
  | { kind: "yes"; handle: number | null; timeText: string | null; priceCents: number | null }
  | { kind: "no"; handle: number | null }
  | { kind: "busy"; handle: number | null; minutes: number }
  | { kind: "done"; handle: number | null; note: string | null }
  | { kind: "invoice"; handle: number | null; amountCents: number };

const YES_WORDS = new Set(["y", "yes", "yep", "yeah", "yup", "accept", "accepted", "sure"]);
const NO_WORDS = new Set(["n", "no", "nope", "pass", "decline", "declined"]);
const BUSY_WORDS = new Set(["busy", "unavailable", "booked"]);
const DONE_WORDS = new Set(["done", "finished", "complete", "completed"]);
const INVOICE_WORDS = new Set(["invoice", "bill", "total"]);

export const DEFAULT_BUSY_MINUTES = 120;

/** A clock time or a price in the rest of a reply: the marks of a vendor taking the job, not refusing it. */
const ACCEPTANCE_SIGNAL = /\$\s*\d|\b\d{1,2}\s*:\s*\d{2}\b|\b\d{1,2}\s*(?:am|pm|a\.m\.?|p\.m\.?)\b/i;

/** "2h", "30m", "2 hours", "90 min" -> minutes. */
export function parseBusyMinutes(text: string): number | null {
  const match = /(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes|d|day|days)\b/i.exec(text);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const minutes = unit.startsWith("d") ? amount * 1440 : unit.startsWith("h") ? amount * 60 : amount;
  const rounded = Math.round(minutes);
  return rounded >= 5 && rounded <= 14 * 1440 ? rounded : null;
}

function parsePriceCents(text: string): number | null {
  const match = /\$\s*(\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?)/.exec(text);
  if (!match) return null;
  const value = Number(match[1]!.replace(/,/g, ""));
  return Number.isFinite(value) && value > 0 ? Math.round(value * 100) : null;
}

/** A bare integer right after the verb is the job number, unless it is the hour of a time ("2pm", "2:30"). */
function takeHandle(rest: string): { handle: number | null; rest: string } {
  const match = /^#?\s*(\d{1,6})\b(?!\s*(?:am|pm|a\.m|p\.m|:|h\b|hr|hour|min|m\b))/i.exec(rest.trim());
  if (!match) return { handle: null, rest: rest.trim() };
  if (match[0].trim().length === 0) return { handle: null, rest: rest.trim() };
  return { handle: Number(match[1]), rest: rest.trim().slice(match[0].length).trim() };
}

export function parseVendorDispatchReply(body: string): VendorDispatchReply | null {
  const text = String(body ?? "").trim();
  if (!text || text.length > 120) return null;
  const word = /^([A-Za-z]+)\b/.exec(text);
  if (!word) return null;
  const verb = word[1]!.toLowerCase();
  const remainder = text.slice(word[0].length).replace(/^[\s,.:!-]+/, "");

  if (YES_WORDS.has(verb)) {
    const price = parsePriceCents(remainder);
    const withoutPrice = remainder.replace(/(?:for\s+)?\$\s*\d[\d,]*(?:\.\d{1,2})?/i, "").trim();
    const taken = takeHandle(withoutPrice);
    const timeText = taken.rest.replace(/^[\s,.:!-]+|[\s,.!-]+$/g, "");
    return { kind: "yes", handle: taken.handle, timeText: timeText || null, priceCents: price };
  }
  if (NO_WORDS.has(verb)) {
    const taken = takeHandle(remainder);
    // "No problem, I can do 3pm" is an acceptance whose first word is NO. Rather than guess which one it is, a
    // leading NO carrying a time or a price is not ours at all: it falls through to the agents, so neither a
    // wrongful decline (which hands the job to the next vendor) nor a wrongful accept is recorded.
    if (ACCEPTANCE_SIGNAL.test(taken.rest)) return null;
    return { kind: "no", handle: taken.handle };
  }
  if (BUSY_WORDS.has(verb)) {
    const taken = takeHandle(remainder);
    // Same shape: "Booked it for 2pm" took the job; it must not park the vendor for two hours.
    if (ACCEPTANCE_SIGNAL.test(taken.rest)) return null;
    return { kind: "busy", handle: taken.handle, minutes: parseBusyMinutes(taken.rest) ?? DEFAULT_BUSY_MINUTES };
  }
  if (INVOICE_WORDS.has(verb)) {
    // "INVOICE $240", "INVOICE 240", "INVOICE #7 $240": a number is dollars; a job number needs its "#".
    const handleMatch = /#\s*(\d{1,6})\b/.exec(remainder);
    const withoutHandle = handleMatch ? remainder.replace(handleMatch[0], " ") : remainder;
    const amountMatch = /\$?\s*(\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?)/.exec(withoutHandle);
    const cents = amountMatch ? Math.round(Number(amountMatch[1]!.replace(/,/g, "")) * 100) : 0;
    if (!Number.isFinite(cents) || cents <= 0) return null;
    return { kind: "invoice", handle: handleMatch ? Number(handleMatch[1]) : null, amountCents: cents };
  }
  if (DONE_WORDS.has(verb)) {
    const taken = takeHandle(remainder);
    return { kind: "done", handle: taken.handle, note: taken.rest || null };
  }
  return null;
}

/** A resident's answer to "Is it fixed? Reply YES or NO". */
export function parseResidentFixedReply(body: string): "fixed" | "not_fixed" | null {
  const text = String(body ?? "").trim();
  if (/^(yes|y|yep|yeah|fixed|all good|resolved)\s*[.!]*$/i.test(text)) return "fixed";
  if (/^(no|n|nope|not fixed|still broken|still a problem)\s*[.!]*$/i.test(text)) return "not_fixed";
  return null;
}
