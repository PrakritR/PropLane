/**
 * Client-safe rules for the vendor work number (Oct 6): who may claim one, how
 * forwarded texts are labelled, how a vendor's reply is routed, and the fair-use
 * cap. Pure - no Supabase, no provider - so the same text is used by the webhook,
 * the settings page and the tests.
 */
import { estimateSmsSegments } from "@/lib/sms/number-registration-policy";

/** Dispatched on `window` when a phone is verified, so a work-number claim on the same page can open up. */
export const PHONE_VERIFIED_EVENT = "proplane:phone-verified";

/** Fair-use cap on the vendor's own text volume, in SMS segments per UTC month. */
export const VENDOR_NUMBER_FAIR_USE_SEGMENTS_PER_MONTH = 1000;

/** A number nobody has texted through for this long is released back to the provider. */
export const VENDOR_NUMBER_IDLE_RELEASE_DAYS = 60;

/** Two conversations active inside this window make a reply ambiguous. */
export const VENDOR_NUMBER_ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** A conversation older than this is not offered in the numbered "Reply to" prompt. */
export const VENDOR_NUMBER_PROMPT_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

/** At most this many conversations are listed in one prompt (single-digit replies). */
export const VENDOR_NUMBER_PROMPT_MAX_CHOICES = 9;

/** Segments a text costs against the fair-use cap (what the carrier bills; 0 for an empty body). */
export function vendorNumberSegments(text: string): number {
  return estimateSmsSegments(text).segmentCount;
}

/** First day of the UTC month the cap resets on. */
export function vendorNumberMonthStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** The label a forwarded text carries: "[<Workspace>] <text>". */
export function forwardedTextBody(workspaceName: string, text: string): string {
  const name = workspaceName.replace(/[\[\]\r\n]+/g, " ").replace(/\s+/g, " ").trim() || "PropLane";
  return `[${name}] ${text}`;
}

export type VendorReplyChoice = { counterpartPhone: string; workspaceName: string };

/** "Reply to: 1) Alder Property Co 2) Green Lake Rentals - reply with the number first." */
export function replyPromptBody(choices: readonly VendorReplyChoice[]): string {
  const list = choices.map((choice, index) => `${index + 1}) ${choice.workspaceName || "PropLane"}`).join(" ");
  return `Reply to: ${list} — reply with the number first.`;
}

/**
 * A reply that starts with a conversation number ("2 Thursday works", "2: ok",
 * "2) ok") picks that conversation and strips the number. Only meaningful when
 * a prompt applies; the caller decides.
 */
export function parseReplyChoice(text: string, choiceCount: number): { index: number; body: string } | null {
  const match = /^\s*([1-9])\s*[):.\-–—]?\s+(\S[\s\S]*)$/.exec(text);
  if (!match) return null;
  const index = Number(match[1]) - 1;
  if (index < 0 || index >= choiceCount) return null;
  return { index, body: match[2]!.trim() };
}

export type ReplyRouteConversation = { counterpartPhone: string; workspaceName: string; lastActivityAt: string };

export type ReplyRouteDecision =
  | { kind: "route"; counterpartPhone: string; body: string }
  | { kind: "prompt"; choices: VendorReplyChoice[] }
  | { kind: "none" };

/**
 * The approved rule (Oct 6): a vendor's text goes to the manager they last
 * talked to. When two or more conversations are active in the last 24 hours -
 * or none is - PropLane asks "Reply to: 1) ... 2) ..." and the vendor answers
 * with the number first.
 *
 * `conversations` is every conversation of this number, any order. The prompt
 * and the numbered reply both read the SAME stable order (workspace name, then
 * phone), so a manager texting in between never renumbers the list.
 */
export function decideVendorReplyRoute(
  conversations: readonly ReplyRouteConversation[],
  text: string,
  now: Date = new Date(),
): ReplyRouteDecision {
  const nowMs = now.getTime();
  const within = (c: ReplyRouteConversation, ms: number) => {
    const at = Date.parse(c.lastActivityAt);
    return Number.isFinite(at) && nowMs - at <= ms && at <= nowMs + 60_000;
  };
  const recent = conversations.filter((c) => within(c, VENDOR_NUMBER_ACTIVE_WINDOW_MS));
  if (recent.length === 1) return { kind: "route", counterpartPhone: recent[0]!.counterpartPhone, body: text.trim() };

  const choices = conversations
    .filter((c) => within(c, VENDOR_NUMBER_PROMPT_LOOKBACK_MS))
    .sort((a, b) => a.workspaceName.localeCompare(b.workspaceName) || a.counterpartPhone.localeCompare(b.counterpartPhone))
    .slice(0, VENDOR_NUMBER_PROMPT_MAX_CHOICES)
    .map((c) => ({ counterpartPhone: c.counterpartPhone, workspaceName: c.workspaceName }));
  if (choices.length === 0) return { kind: "none" };
  const picked = parseReplyChoice(text, choices.length);
  if (picked) return { kind: "route", counterpartPhone: choices[picked.index]!.counterpartPhone, body: picked.body };
  return { kind: "prompt", choices };
}

/** The vendor-side text when nobody has texted this number yet. */
export const VENDOR_NUMBER_NO_CONVERSATION_NOTICE =
  "PropLane: no manager has texted this number yet, so there is no one to send your message to.";

/** Shown in PropLane when the monthly fair-use cap pauses vendor-side texts. */
export const VENDOR_NUMBER_CAP_NOTICE =
  "You reached the 1,000 texts a month fair-use limit. Texts to your phone and replies from it are paused until the 1st; everything still arrives in PropLane.";
