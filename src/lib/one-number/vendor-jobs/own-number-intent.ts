/**
 * What a vendor texting their OWN PropLane number means, read by code (no model). Two things only:
 * a work ask ("any work?", "got any jobs", "what's available") and a reply to the list that ask was answered with
 * ("2", "see 2", "bid 2 $120"). Everything else is the relay as it always was. Pure.
 */
import { asksForJobs, CONTROL_ONLY_RE } from "@/lib/one-number/vendor-jobs/intent";

const MAX_ASK_CHARS = 80;

/** A short text that is only a question about open work. A long message is a note to a manager, never a work ask. */
const WORK_ASK_PATTERNS: RegExp[] = [
  /^(?:(?:hey|hi|hello|yo)\b[\s,!.]*)?(?:(?:is there|are there|got|have you got|do you have|you got|u got|any chance of)\s+)?(?:any|some|more)\s+(?:more\s+|new\s+|open\s+|available\s+)?(?:work|jobs?|gigs?|leads?)\b[^.!]{0,30}$/i,
  /^(?:(?:hey|hi|hello|yo)\b[\s,!.]*)?(?:work\s*\?+|jobs?\s*\??|gigs?\s*\??|leads?\s*\?+)\s*$/i,
  /^(?:(?:hey|hi|hello|yo)\b[\s,!.]*)?(?:any\s+)?(?:work|jobs?|gigs?)\s+(?:today|tomorrow|this week|near me|nearby|available|open|right now)\b[\s?.!]*$/i,
  /^(?:(?:hey|hi|hello|yo)\b[\s,!.]*)?(?:is there |got |have you got )?(?:anything|something)\s+(?:open|available|new|near me|nearby|for me|to do|today)\b[\s?.!]*$/i,
  /^(?:(?:hey|hi|hello|yo)\b[\s,!.]*)?what(?:'s| is)\s+(?:available|open|new)\b[^.!]{0,20}$/i,
  /^(?:(?:hey|hi|hello|yo)\b[\s,!.]*)?what\s+(?:jobs?|work|gigs?)\s+(?:are|is)\s+(?:there|available|open)\b[^.!]{0,20}$/i,
];

export function asksForWorkOnOwnNumber(text: string): boolean {
  const body = String(text ?? "").trim();
  if (!body || body.length > MAX_ASK_CHARS || CONTROL_ONLY_RE.test(body)) return false;
  return WORK_ASK_PATTERNS.some((re) => re.test(body)) || (body.length <= 60 && asksForJobs(body));
}

export type OwnNumberJobReply = { action: "see" | "bid"; index: number; priceCents: number | null };

const JOB_REPLY_RE =
  /^\s*(?:(bid|see|view|show|detail|details|info)\b[\s:#-]*)?#?\s*([1-9])\b\s*(?:(?:for|at|@)?\s*(\$\s*\d[\d,]*(?:\.\d{1,2})?|\d[\d,]*(?:\.\d{1,2})?))?\s*[.!]?\s*$/i;

/** "2" / "see 2" -> see; "bid 2" / "bid 2 $120" / "2 $120" -> bid. A bare amount counts only after the word BID or with a $. */
export function parseOwnNumberJobReply(text: string): OwnNumberJobReply | null {
  const body = String(text ?? "");
  if (!body.trim() || body.length > 40 || CONTROL_ONLY_RE.test(body)) return null;
  const match = JOB_REPLY_RE.exec(body);
  if (!match) return null;
  const verb = (match[1] ?? "").toLowerCase();
  const rawPrice = match[3] ?? "";
  if (rawPrice && !rawPrice.includes("$") && verb !== "bid") return null;
  let priceCents: number | null = null;
  if (rawPrice) {
    const value = Number(rawPrice.replace(/[$,\s]/g, ""));
    if (!Number.isFinite(value) || value <= 0 || value > 999_999) return null;
    priceCents = Math.round(value * 100);
  }
  const bid = verb === "bid" || priceCents !== null;
  return { action: bid ? "bid" : "see", index: Number(match[2]), priceCents };
}
