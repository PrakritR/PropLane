/**
 * Keyword router for inbound texts on a manager's PropLane number — the brain
 * behind the public "Text to tour" / "Text to apply" listing CTAs.
 *
 * The TRANSPORT (Twilio webhook, send path, inbox mirroring) lives elsewhere
 * and calls `routeInboundSms` with one normalized inbound message. This module
 * decides what, if anything, to reply and performs the intent's REAL side
 * effect:
 *
 * - tour intent  → creates ONE pending tour inquiry (the same
 *   `axis_admin_partner_inquiries_v1` payload row + a single standalone
 *   `partner_inquiry_request_<id>_0` record the public booking page writes),
 *   with candidate windows drawn from the SAME offering the public
 *   availability grid computes: published future slots, else the 9-5 default
 *   grid for a LIVE listing, minus pending-inquiry and booked-tour blocks
 *   (`loadManagerTourBlocksResult`). The manager confirms through the existing
 *   accept/proposal machinery — nothing here books a tour directly.
 * - apply intent → replies with the property's real application wizard link,
 *   phone prefilled. Deliberately NO application row is created: a draft
 *   application needs an email and a browser-held resume token, so a
 *   server-minted row would be an orphan the prospect can never resume and a
 *   guaranteed duplicate once they really apply.
 * - a greeting or otherwise unrecognized first contact → a menu that
 *   identifies the business and how to opt out, so a prospect is never met
 *   with silence.
 * - two QUESTION carve-outs the router answers itself with grounded data
 *   the leasing agent cannot (or cannot cheaply) produce: TOUR-WINDOW
 *   availability ("what times?") → the real computed open slots; rent
 *   ("how much?") → the listing's stored rentLabel + listing link. Each
 *   carve-out fires ONLY when that data actually loaded — an availability or
 *   listings read failure falls through (`handled: false`) instead of
 *   answering from nothing. Both are matched on INTERROGATIVE phrasing about
 *   their own subject, never on a bare mention: "is the unit still
 *   available?" is a question about the home and "my rent budget is 2000" is
 *   a statement, so both belong to the agent.
 * - every other QUESTION, first contact or not → `handled: false`, so the
 *   transport's default handler (the Claude leasing agent) answers it with
 *   grounded listing facts instead of a canned menu. The site's own "Text
 *   a question" CTA lands here.
 *
 * Contract with the transport:
 * - `handled: true` with `autoReplyBody` → send exactly that reply.
 * - `handled: true` with NO body → deliberate silence (opted out, or a human
 *   manager owns the conversation). The transport must not fall through to
 *   any other auto-reply.
 * - `handled: false` → this router produced nothing; default handling (e.g.
 *   the Claude leasing agent) runs. It is returned for any non-opted-out,
 *   non-human-owned conversation whose message this router does not answer —
 *   including a first-contact question — so the compliance gates here cover
 *   the default path too. On a FIRST message the result also carries
 *   `firstContactFooter`, which the transport must append to the default
 *   handler's reply so the first automated message still identifies the
 *   business and how to opt out.
 *
 * No-silence chain: router menu for a greeting/unrecognized first contact →
 * the leasing agent for questions → the transport falls through on
 * `handled: false` OR on a throw from this module, and can use the exported
 * {@link firstContactMenuReply} as its own last-resort body if its default
 * handler also fails.
 * - Replies this router produces MUST be logged with `source: "automated"`
 *   (`deliverLeasingSmsReply` already does) — the human-takeover check below
 *   reads any non-`automated` outbound row as "a manager is talking".
 *
 * Auto-reply suppression rule (stated once, tested):
 * once ANY outbound message in THIS CONVERSATION was authored by a human
 * (source `work_number` or `relay` — the portal composer and the manager-cell
 * relay), automated replies stop for that thread permanently. Bot traffic
 * always logs `source: "automated"`, so a single manager reply flips the
 * thread to human-owned and this router goes silent. The scope is the
 * `conversation_key`, not the phone: the same phone can hold a resident thread
 * and a prospect thread, and silencing one because of the other is total
 * silence (this result suppresses the leasing agent too).
 *
 * Read-failure rule (stated once, tested): every read this module makes fails
 * CLOSED, because an unreadable state is not an empty state. An unreadable
 * takeover history is treated as human-owned (silence); unreadable inquiries,
 * availability, tour blocks, or listings abort the tour create and answer with
 * the web booking link or retryable copy, never a fabricated default grid,
 * never an already-held window, and never "no homes are open".
 *
 * Idempotency rule (stated once, tested): one pending tour inquiry per
 * (manager, prospect phone). A second "tour" text updates/reminds instead of
 * creating another; slot picks and name/email follow-ups EDIT that inquiry.
 * Apply texts create no rows at all, so they cannot duplicate anything.
 *
 * STOP / HELP (A2P):
 * - STOP/UNSUBSCRIBE/… records the opt-out ledger row and stays silent —
 *   Twilio's Advanced Opt-Out sends the carrier-required confirmation, and the
 *   transport's consent gate (which reads the ledger we just wrote) would
 *   refuse a non-control send to that number anyway.
 * - HELP/INFO returns help text identifying the business with opt-out
 *   instructions (app-side — Twilio's default HELP reply is not guaranteed to
 *   be configured).
 * - START/UNSTOP records the opt-in and welcomes the person back. A bare
 *   "YES" from an opted-out number also resumes (carrier-standard); a "yes"
 *   from an active conversation stays conversational.
 * - Any reply to a first-time contact carries the business identification +
 *   "Reply STOP to opt out" footer.
 */

import { track } from "@/lib/analytics/posthog";
import {
  classifyLeasingIntent,
  extractBundleIdHint,
  extractPropertyIdHint,
  extractPropertyLabelHint,
  type LeasingIntent,
} from "@/lib/claw-leasing-links";
import { publicAppOrigin } from "@/lib/claw-leasing-bot.server";
import { normalizePhoneE164 } from "@/lib/communication-other-recipients";
import {
  buildManagerApplyUrl,
  buildManagerListingUrl,
  buildManagerTourUrl,
} from "@/lib/manager-property-links";
import { formatPacificDateTime } from "@/lib/pacific-time";
import {
  isPhoneOptedOut,
  normalizeConsentPhone,
  profilePhoneVariants,
  recordOptIn,
  recordOptOut,
} from "@/lib/sms-consent";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { INQUIRIES_RECORD_ID } from "@/lib/tour-inquiry.server";
import { loadManagerTourBlocksResult, proposeTourConfirmation } from "@/lib/tour-proposal.server";
import {
  buildDefaultTourSlotKeys,
  payloadSlots,
  safePropertyId,
  shouldOfferDefaultTourGrid,
  slotBlocked,
  slotIsBookable,
  slotStartMs,
} from "@/lib/tour-slot-math";

export type InboundSmsContext = {
  fromPhone: string;
  toPhone: string; // the manager number that was texted
  body: string;
  managerId: string;
  /**
   * The thread's durable conversation key, and it MUST be byte-identical to
   * `buildConversationKey({ ownerManagerUserId, role, counterpartyUserId,
   * counterpartyPhone })` (`sms-conversation-identity.ts`) — the same value
   * `logManagerSmsMessage` stores in `manager_sms_messages.conversation_key`.
   * Note `conversationPhoneRef` normalizes to `+1XXXXXXXXXX`, so a bare
   * 10-digit person_ref is NOT the same key.
   *
   * This is load-bearing for a SAFETY gate, not just a label:
   * {@link humanOwnsConversation} matches human-authored outbound rows against
   * it, and a key that does not match what the writers store silently reports
   * "no human here" — the bot then talks over a manager's live conversation.
   * The `counterparty_role = 'unknown'` and NULL-key fallbacks there bound the
   * damage; they are not a licence to send an approximate key.
   */
  conversationId: string;
  isFirstMessageInConversation: boolean;
};

export type SmsIntentResult = {
  handled: boolean; // true = this router produced the outcome; default handling is skipped
  autoReplyBody?: string; // the automated response to send back, if any
  /**
   * Present ONLY when `handled` is false on the FIRST message of a
   * conversation: the A2P business-identification + opt-out footer. The
   * transport must append it to whatever its default handler replies, so the
   * first automated message a new person receives always identifies the
   * business and says how to opt out — even when the answer comes from the
   * leasing agent rather than this router (firstmate decision, sms-footer-gate).
   */
  firstContactFooter?: string;
};

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;

/* ----------------------------------------------------------------------- */
/* Control keywords (mirrors /api/twilio/inbound — second line of defense)  */
/* ----------------------------------------------------------------------- */

const STOP_KEYWORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const START_KEYWORDS = new Set(["START", "UNSTOP"]);
const HELP_KEYWORDS = new Set(["HELP", "INFO"]);

/** Offered per tour request; each is one 30-minute window the manager can confirm. */
const OFFERED_TOUR_SLOTS = 3;
/** Offered windows are spread at least this far apart so the options are real alternatives. */
const OFFERED_SLOT_MIN_GAP_MS = 3 * 60 * 60 * 1000;

const INQUIRY_EVENT_RECORD_TYPE = "partner_inquiry_request";

/**
 * Intents whose whole answer is a WIZARD LINK. One list, read by the branch
 * that sends the link AND by the contact-fill guards that must not swallow the
 * message before it gets there — the bundle CTA drafts "I'd like to apply for
 * the bundle "X" at Y", so a guard that names only `apply` loses that lead to
 * the tour-email fill exactly the way an unguarded one lost `apply`.
 */
const WIZARD_LINK_INTENTS: LeasingIntent[] = ["apply", "bundle"];

function wantsWizardLink(intent: LeasingIntent): boolean {
  return WIZARD_LINK_INTENTS.includes(intent);
}

/** An intent that is its own request, so a pending inquiry's contact fill must defer to it. */
function intentOutranksContactFill(intent: LeasingIntent): boolean {
  return intent === "tour" || wantsWizardLink(intent);
}

const OPT_BACK_IN_REPLY =
  "You're opted back in. Reply TOUR to schedule a tour, APPLY to start an application, or HELP for help. Reply STOP to opt out.";

/* ----------------------------------------------------------------------- */
/* Pure helpers (exported for unit tests)                                   */
/* ----------------------------------------------------------------------- */

/** "1" / "option 2" / "#3" / "2)" → zero-based index into the offered windows. */
export function parseSlotPick(body: string, offeredCount: number): number | null {
  const m = /^\s*(?:option\s*|#\s*)?([1-9])\s*[).]?\s*$/i.exec(body);
  if (!m) return null;
  const pick = Number(m[1]) - 1;
  return pick < offeredCount ? pick : null;
}

export function extractEmailCandidate(body: string): string | null {
  const m = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/.exec(body);
  return m ? m[0] : null;
}

/** Words that are an ANSWER, an intent, or a date — never the name on a tour. */
const NAME_STOPWORDS =
  /\b(tour|apply|application|stop|help|start|yes|yeah|no|nope|ok|okay|sure|thanks|thank|rent|price|time|times|when|what|how|info|hi|hello|hey|maybe|tomorrow|today|tonight|anytime|weekend|weekday|noon|morning|afternoon|evening|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/;

/**
 * A short human-name-looking message ("Jane Doe", "Sarah", "name: Jane"). Only
 * consulted when a pending SMS tour inquiry is still nameless and nothing else
 * matched, so a false positive costs a name field, never a wrong action.
 *
 * A BARE single word counts only when it is capitalized. The reply that creates
 * an inquiry ends with "What name should we put on the tour?", and a first name
 * is the likeliest answer to it — rejecting "Sarah" leaves the manager
 * confirming a tour for "Guest". {@link NAME_STOPWORDS} already blocks the
 * intent, affirmation, and day words a one-word reply would otherwise be, and
 * capitalization separates an answered prompt from a stray lowercase remark.
 */
export function extractNameCandidate(body: string): string | null {
  const explicit = /^\s*(?:my\s+name\s+is|name\s*[:=-])\s*(.{2,60})$/i.exec(body.trim());
  const raw = (explicit ? explicit[1] : body).trim().replace(/[.!]+$/, "");
  if (!raw || raw.length > 60) return null;
  if (/[@\d]/.test(raw)) return null;
  const words = raw.split(/\s+/);
  if (words.length < 1 || words.length > 4) return null;
  if (!words.every((w) => /^[A-Za-z][A-Za-z'’.-]*$/.test(w))) return null;
  if (NAME_STOPWORDS.test(raw.toLowerCase())) return null;
  if (explicit || words.length >= 2) return raw;
  return /^[A-Z]/.test(raw) ? raw : null;
}

/** Nouns that make a question about the TOUR CALENDAR rather than the home. */
const TOUR_WINDOW_NOUN = "times?|time slots?|slots?|days?|windows?|showings?|openings?|hours?";
const ASKS_FOR_WINDOW = new RegExp(`\\b(what|which|any|wat)\\s+(?:${TOUR_WINDOW_NOUN})\\b`);
const AVAILABLE_WINDOW = new RegExp(`\\bavailab(?:le|ility)\\s+(?:${TOUR_WINDOW_NOUN})\\b`);
const WINDOW_IS_OPEN = new RegExp(
  `\\b(?:${TOUR_WINDOW_NOUN})\\s+(?:are|is)\\s+(?:still\\s+)?(?:availab(?:le|ility)|open|free)\\b`,
);

/**
 * "what times…", "when can I…", "any open slots?", "what's your availability?"
 * — asking for TOUR WINDOWS.
 *
 * Deliberately narrower than "the message says available": "is the unit still
 * available?" is a question about the HOME, and answering it with a list of
 * tour times never answers what was asked while also preempting the leasing
 * agent, which owns every question this router cannot ground. The dividing
 * line is what the word is attached to — a POSSESSED or bare availability
 * ("your availability", "the availability", "Availability?") is the calendar,
 * while an availability PREDICATED on a thing ("the unit is available") is the
 * home. Neither clause below matches that sentence.
 */
export function looksLikeAvailabilityQuestion(body: string): boolean {
  const t = body.trim().toLowerCase();
  return (
    ASKS_FOR_WINDOW.test(t) ||
    /\bwhen\s+(can|could|is|are|do|does|would)\b/.test(t) ||
    AVAILABLE_WINDOW.test(t) ||
    WINDOW_IS_OPEN.test(t) ||
    /\b(your|the)\s+availab(?:le|ility)\b/.test(t) ||
    /^\s*availability\s*\??\s*$/.test(t) ||
    /^\s*times?\??\s*$/.test(t)
  );
}

const RENT_NOUN = /\b(rent|price|pricing|cost)\b/;

/**
 * "how much is rent", "what's the price?", "rent?" — ASKING what it costs.
 *
 * Requires interrogative phrasing, not a bare mention: "my rent budget is 2000
 * and I need two bedrooms near the light rail" states a constraint, and the
 * canned price line would replace the grounded answer the leasing agent can
 * give it.
 */
export function looksLikeRentQuestion(body: string): boolean {
  const t = body.trim().toLowerCase();
  if (/\bhow\s+much\b/.test(t)) return true;
  if (!RENT_NOUN.test(t)) return false;
  return /\bwhat(?:'s|s)?\b/.test(t) || /\?\s*$/.test(t) || /^\s*(rent|price|pricing|cost)s?\s*[?.!]*\s*$/.test(t);
}

/** "yes" / "ok" / "sure" — an affirmative continuation, not an intent of its own. */
export function looksLikeAffirmation(body: string): boolean {
  return /^\s*(yes|yeah|yep|ya|ok|okay|sure|sounds good|that works)\s*[.!]*\s*$/i.test(body);
}

export function looksLikeNotInterested(body: string): boolean {
  return /^\s*(no|nope|no thanks|not interested|no thank you)\s*[.!]*\s*$/i.test(body);
}

/**
 * Pacific wall-clock label for a slot key, e.g. "Aug 5, 10:00 AM PT".
 * The trailing " PT" is load-bearing: SMS has no page chrome telling an
 * out-of-region prospect which zone the calendar uses, and every slotKey
 * is Pacific wall time by design (`TOUR_CALENDAR_TIME_ZONE`).
 */
export function tourSlotLabel(slotKey: string): string {
  const ms = slotStartMs(slotKey);
  return ms === null ? "that time" : `${formatPacificDateTime(new Date(ms))} PT`;
}

/** Same Pacific+PT shape for a free-form ISO instant (slot picks without a key). */
function smsInstantLabel(iso: string): string {
  return `${formatPacificDateTime(iso)} PT`;
}

/**
 * Spread the offer: chronological open slots, consecutive picks at least
 * {@link OFFERED_SLOT_MIN_GAP_MS} apart so the offered options are genuinely
 * different times, falling back to adjacent slots when the calendar is tight.
 */
export function pickOfferedSlots(openSlots: string[], count: number = OFFERED_TOUR_SLOTS): string[] {
  const sorted = [...new Set(openSlots)]
    .map((key) => ({ key, ms: slotStartMs(key) }))
    .filter((s): s is { key: string; ms: number } => s.ms !== null)
    .sort((a, b) => a.ms - b.ms);
  const picked: { key: string; ms: number }[] = [];
  for (const slot of sorted) {
    if (picked.length >= count) break;
    const last = picked.at(-1);
    if (!last || slot.ms - last.ms >= OFFERED_SLOT_MIN_GAP_MS) picked.push(slot);
  }
  for (const slot of sorted) {
    if (picked.length >= count) break;
    if (!picked.some((p) => p.key === slot.key)) picked.push(slot);
  }
  return picked.sort((a, b) => a.ms - b.ms).map((s) => s.key);
}

/** First-contact footer: business identification + opt-out, per A2P. */
export function complianceFooter(businessLabel: string | null): string {
  const identity = businessLabel ? `${businessLabel} via PropLane` : "PropLane";
  return `${identity}. Msg&data rates may apply. Reply STOP to opt out, HELP for help.`;
}

/** The TOUR/APPLY menu a greeting or unrecognized message gets. */
export function assistantMenuBody(listingLabel: string | null): string {
  const where = listingLabel ? ` for ${listingLabel}` : "";
  return `Hi! This is the leasing line${where}. I can help right away:\n• Reply TOUR to schedule a tour\n• Reply APPLY to start an application\nOr ask a question and the property manager will follow up.`;
}

/**
 * The full first-contact menu reply, footer included — byte-identical to what
 * the router sends for a greeting/unrecognized first contact, because both
 * halves are built from the SAME resolved listing label. The transport may
 * send it as a last-resort body when its own default handler (the leasing
 * agent) throws, so a first contact is never met with silence.
 */
export function firstContactMenuReply(listingLabel: string | null): string {
  return `${assistantMenuBody(listingLabel)}\n\n${complianceFooter(listingLabel)}`;
}

/** "Reply 1 or 2" / "Reply 1, 2 or 3" for however many windows are on offer. */
function replyPickInstruction(count: number): string {
  if (count <= 1) return "Reply 1 to confirm that time";
  const numbers = Array.from({ length: count }, (_, i) => String(i + 1));
  const list = count === 2 ? numbers.join(" or ") : `${numbers.slice(0, -1).join(", ")} or ${numbers.at(-1)}`;
  return `Reply ${list} to request that time`;
}

/* ----------------------------------------------------------------------- */
/* DB lookups                                                               */
/* ----------------------------------------------------------------------- */

type ListingRow = {
  id: string;
  label: string;
  rentLabel: string | null;
};

function listingLabelFromPropertyData(pd: Record<string, unknown> | null | undefined): string {
  const text = (key: string) => {
    const v = pd?.[key];
    return typeof v === "string" ? v.trim() : "";
  };
  return text("buildingName") || text("title") || text("address");
}

type ListingsLookup = { ok: true; listings: ListingRow[] } | { ok: false };

/**
 * This manager's LIVE listings. A failed read is reported as `{ ok: false }`,
 * never as an empty portfolio: "we could not look it up" and "this manager has
 * nothing to tour" lead to opposite replies — one is retryable, the other is a
 * dead end for the prospect.
 */
async function loadManagerListings(db: Db, managerId: string): Promise<ListingsLookup> {
  const { data, error } = await db
    .from("manager_property_records")
    .select("id, status, property_data")
    .eq("manager_user_id", managerId)
    .eq("status", "live")
    .order("updated_at", { ascending: false })
    .limit(50);
  if (error) {
    console.error("sms-intent-router listings read failed", error.message);
    return { ok: false };
  }
  const out: ListingRow[] = [];
  for (const row of (data ?? []) as { id?: unknown; property_data?: unknown }[]) {
    const id = typeof row.id === "string" ? row.id.trim() : "";
    if (!id) continue;
    const pd =
      row.property_data && typeof row.property_data === "object" && !Array.isArray(row.property_data)
        ? (row.property_data as Record<string, unknown>)
        : null;
    const rentLabel = typeof pd?.rentLabel === "string" ? pd.rentLabel.trim() : null;
    out.push({
      id,
      label: listingLabelFromPropertyData(pd) || id,
      rentLabel: rentLabel || null,
    });
  }
  return { ok: true, listings: out };
}

/**
 * An UNAMBIGUOUS property id in the body: a `propertyId=` param, a listing URL,
 * or a `mgr-…` id. Deliberately excludes `extractPropertyIdHint`'s loose
 * `listing|property|home <token>` capture, which reads "the property manager"
 * as the id `manager` — a miss on that is noise, while a miss on one of these
 * three is the prospect naming a house we do not have.
 */
function explicitPropertyIdHint(body: string): string | null {
  const m =
    body.match(/propertyId=([a-zA-Z0-9._-]+)/i) ||
    body.match(/\/rent\/listings\/([a-zA-Z0-9._-]+)/i) ||
    body.match(/\b(mgr-[a-z0-9-]+)\b/i);
  return m?.[1]?.trim() || null;
}

export type TargetListingResolution = {
  listing: ListingRow | null;
  /**
   * Set when the body named an EXPLICIT property id that matches none of this
   * manager's live listings, so the caller can say so instead of substituting
   * another house.
   */
  unresolvedPropertyId: string | null;
};

/**
 * The listing this message is about, scoped to THIS manager's LIVE records
 * (the only publicly reachable status): explicit id hint, then label hint
 * (exact beats partial), then the
 * pending inquiry's property, then the manager's only/most recent listing.
 * The last fallback can guess wrong for a multi-listing manager, so every
 * reply NAMES the resolved property — a wrong guess is visible and
 * correctable, never silent.
 *
 * An EXPLICIT id that matches nothing is the one case that does NOT fall back:
 * the prospect gave an unambiguous target, so "we don't have that one" is the
 * honest answer. Falling through to `listings[0]` would file a real tour
 * inquiry against a house they never asked about, and naming it in the reply
 * is far weaker mitigation than for a message that named no house at all.
 */
export function resolveTargetListing(args: {
  body: string;
  listings: ListingRow[];
  pendingInquiryPropertyId?: string | null;
}): TargetListingResolution {
  const { body, listings } = args;
  const resolved = (listing: ListingRow | null): TargetListingResolution => ({
    listing,
    unresolvedPropertyId: null,
  });
  if (listings.length === 0) return resolved(null);

  const explicitId = explicitPropertyIdHint(body);
  const idHint = explicitId ?? extractPropertyIdHint(body);
  if (idHint) {
    const hit = listings.find((l) => l.id === idHint || safePropertyId(l.id) === safePropertyId(idHint));
    if (hit) return resolved(hit);
    if (explicitId) return { listing: null, unresolvedPropertyId: explicitId };
  }

  const labelHint = extractPropertyLabelHint(body)?.toLowerCase();
  if (labelHint) {
    const exact = listings.find((l) => l.label.toLowerCase() === labelHint);
    if (exact) return resolved(exact);
    const partial = listings.find((l) => {
      const label = l.label.toLowerCase();
      return label.includes(labelHint) || labelHint.includes(label);
    });
    if (partial) return resolved(partial);
  }

  const pendingId = args.pendingInquiryPropertyId?.trim();
  if (pendingId) {
    const pending = listings.find((l) => l.id === pendingId);
    if (pending) return resolved(pending);
  }

  return resolved(listings[0] ?? null);
}

/**
 * True when a human manager has ever replied in THIS conversation.
 *
 * Scoped on `conversation_key`, not on the phone: conversation identity here is
 * `owner:role:person_ref` (`sms-conversation-identity.ts`), so one phone can
 * legitimately hold a resident thread and a prospect thread with the same
 * manager. Matching on the phone alone collapses them — a manager who once
 * replied in the resident thread would permanently silence the leasing thread,
 * and because this router returns `handled: true` with no body, that suppresses
 * the leasing agent too: total silence for a person who just texted the
 * listing's number.
 *
 * Narrowing to the key is only safe because UNATTRIBUTED history still counts.
 * A role is a guess made by whichever writer stored the row, and the portal
 * composer's "Other" / new-recipient path has nothing to guess from: it passes
 * `counterpartyRole: match?.counterpartyRole`, which is `undefined` for a phone
 * with no existing thread, so `deriveCounterpartyRole` returns `unknown` and
 * the row lands on `<mgr>:unknown:<phone>`. That is a manager cold-texting a
 * prospect — precisely the conversation the bot must not barge into — and an
 * exact-key match misses it in both directions. So this is human-owned when a
 * human-authored outbound for the same manager + phone:
 *
 * - carries THIS `conversation_key`, or
 * - carries `counterparty_role = 'unknown'` (never attributed to a thread), or
 * - carries NO `conversation_key` (unattributable legacy history — the same
 *   rule `manager-sms-messages.server.ts` applies before sweeping by phone).
 *
 * A row attributed to a DIFFERENT definite role (a resident thread) is still
 * excluded: that is the whole point of scoping by key. Every other failure
 * fails closed too — an unreadable takeover history reads as human-owned. A bot
 * that was wrongly quiet for one transient outage is recoverable; a bot that
 * barges into a live human conversation is not.
 */
async function humanOwnsConversation(
  db: Db,
  managerId: string,
  fromPhone: string,
  conversationId: string,
): Promise<boolean> {
  const humanOutbound = () =>
    db
      .from("manager_sms_messages")
      .select("id")
      .eq("manager_user_id", managerId)
      .in("resident_phone", profilePhoneVariants(fromPhone))
      .eq("direction", "outbound")
      .neq("source", "automated");

  try {
    const thread = conversationId?.trim();
    if (!thread) {
      // No thread identity to scope by — the phone is all we have.
      const { data, error } = await humanOutbound().limit(1);
      if (error) {
        console.error("sms-intent-router takeover read failed", error.message);
        return true;
      }
      return (data ?? []).length > 0;
    }
    const reads = await Promise.all([
      humanOutbound().eq("conversation_key", thread).limit(1),
      humanOutbound().eq("counterparty_role", "unknown").limit(1),
      humanOutbound().is("conversation_key", null).limit(1),
    ]);
    const failed = reads.find((read) => read.error);
    if (failed) {
      console.error("sms-intent-router takeover read failed", failed.error?.message);
      return true;
    }
    return reads.some((read) => (read.data ?? []).length > 0);
  } catch (err) {
    console.error("sms-intent-router takeover read threw", err);
    return true;
  }
}

/* ----------------------------------------------------------------------- */
/* Tour inquiry storage (same shapes the public booking page writes)        */
/* ----------------------------------------------------------------------- */

type InquiryPayloadRow = Record<string, unknown>;

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textField(row: Record<string, unknown> | null | undefined, key: string): string {
  const value = row?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function inquiryRows(rowData: unknown): InquiryPayloadRow[] {
  const payload = asObject(rowData)?.payload;
  return Array.isArray(payload)
    ? payload.filter((item): item is InquiryPayloadRow => Boolean(asObject(item)))
    : [];
}

type InquiryWindow = { start: string; end: string; slotKey: string; adminUserId: string };

/**
 * An inquiry's requested windows, with the SAME `proposedStart`/`proposedEnd`
 * fallback the shared `windowsFromPayload` applies. The web booking client
 * writes that single-window shape, and both readers of these rows expand it, so
 * reading only `requestedWindows` here would see a web-created inquiry as
 * window-less: `standaloneRecordsFor` would then write nothing and an SMS
 * name/email follow-up would leave the pre-edit payload on the `_0` record the
 * manager's calendar and the public availability route actually read.
 */
function windowsOf(row: InquiryPayloadRow): InquiryWindow[] {
  const requested = Array.isArray(row.requestedWindows) ? row.requestedWindows : [];
  const windows = requested
    .map(asObject)
    .filter((w): w is Record<string, unknown> => Boolean(w))
    .map((w) => ({
      start: textField(w, "start"),
      end: textField(w, "end"),
      slotKey: textField(w, "slotKey"),
      adminUserId: textField(w, "adminUserId"),
    }))
    .filter((w) => w.start && w.end);
  if (windows.length > 0) return windows;
  const start = textField(row, "proposedStart") || textField(row, "start");
  const end = textField(row, "proposedEnd") || textField(row, "end");
  if (!start || !end) return [];
  return [
    {
      start,
      end,
      slotKey: textField(row, "slotKey"),
      adminUserId: textField(row, "adminUserId") || textField(row, "managerUserId"),
    },
  ];
}

/**
 * The idempotency predicate — one pending tour inquiry per (manager, prospect
 * phone). Shared by the early check and the re-check the create runs against
 * the payload it is about to merge onto, so the two can never drift apart.
 */
function pendingTourRowIn(
  rows: InquiryPayloadRow[],
  managerId: string,
  phoneKey: string,
): InquiryPayloadRow | null {
  return (
    rows.find(
      (item) =>
        textField(item, "kind") === "tour" &&
        textField(item, "status").toLowerCase() === "pending" &&
        textField(item, "managerUserId") === managerId &&
        normalizeConsentPhone(textField(item, "phone")) === phoneKey,
    ) ?? null
  );
}

/**
 * The one pending tour inquiry for this manager + prospect phone — the FAST
 * PATH of the idempotency check. The payload it read is deliberately not
 * returned: every writer re-reads the singleton immediately before merging, so
 * a stale snapshot can never become a write base, and `createSmsTourInquiry`
 * re-runs {@link pendingTourRowIn} on that fresh payload before inserting.
 *
 * A failed read is reported as `{ ok: false }`, never as "no inquiries": the
 * caller must not create from an unknown payload (that would duplicate an
 * existing pending inquiry).
 */
async function findPendingTourInquiry(
  db: Db,
  managerId: string,
  fromPhone: string,
): Promise<{ ok: true; pending: InquiryPayloadRow | null } | { ok: false }> {
  const { data, error } = await db
    .from("portal_schedule_records")
    .select("row_data")
    .eq("id", INQUIRIES_RECORD_ID)
    .maybeSingle();
  if (error) {
    console.error("sms-intent-router inquiries read failed", error.message);
    return { ok: false };
  }
  const phoneKey = normalizeConsentPhone(fromPhone);
  if (!phoneKey) return { ok: true, pending: null };
  return { ok: true, pending: pendingTourRowIn(inquiryRows(data?.row_data), managerId, phoneKey) };
}

/**
 * offered = (published future slots, else the 9-5 default grid) − pending
 * inquiries − booked tours — the same formula as the public availability
 * route, sharing its primitives. Two deliberate deltas, both documented:
 * Google-calendar busy time is not subtracted here (matching
 * `findFirstOpenTourSlot`, the other server-side slot picker — the manager
 * still confirms before anything books), and the published-slot POST guard is
 * not re-run for default-grid slots (the public GET offers them; requiring
 * publication here would make SMS tours dead for every calendar-less manager).
 *
 * A failed availability read is fatal (`{ ok: false }`), never an empty
 * published set: empty is what triggers the 9-5 default grid, so swallowing the
 * error would synthesize windows this manager may never have published and then
 * book a real inquiry into one — the public availability route treats the same
 * read as a 500 for the same reason.
 */
async function listOpenTourSlots(
  db: Db,
  managerId: string,
  propertyId: string,
): Promise<{ ok: true; slots: string[] } | { ok: false }> {
  const { data, error } = await db
    .from("portal_schedule_records")
    .select("property_id, record_type, row_data")
    .eq("manager_user_id", managerId)
    .in("record_type", ["manager_property_availability", "manager_availability"]);
  if (error) {
    console.error("sms-intent-router availability read failed", error.message);
    return { ok: false };
  }

  const propertyScoped: string[] = [];
  const global: string[] = [];
  for (const row of (data ?? []) as { property_id?: unknown; record_type?: unknown; row_data?: unknown }[]) {
    const slots = payloadSlots(row.row_data);
    if (slots.length === 0) continue;
    if (row.record_type === "manager_property_availability") {
      const pid = typeof row.property_id === "string" ? row.property_id.trim() : "";
      if (pid && pid !== propertyId && safePropertyId(pid) !== safePropertyId(propertyId)) continue;
      propertyScoped.push(...slots);
    } else {
      global.push(...slots);
    }
  }
  // Property-scoped rows replace the manager's global calendar for this house,
  // mirroring the availability route's precedence.
  const published = propertyScoped.length > 0 ? propertyScoped : global;
  const publishedFuture = published.filter((slot) => slotIsBookable(slot));
  const base = shouldOfferDefaultTourGrid(publishedFuture) ? buildDefaultTourSlotKeys() : publishedFuture;

  // Same rule as the availability read above: an unreadable block set is not an
  // empty one. Swallowing it would offer — and then file a real inquiry into —
  // a window a pending inquiry or a confirmed tour already holds, and the
  // partial unique index only guards the FIRST window against other inquiry
  // rows, so a collision with a booked tour has nothing beneath it.
  const blocks = await loadManagerTourBlocksResult(db, managerId);
  if (!blocks.ok) return { ok: false };
  return {
    ok: true,
    slots: [...new Set(base)].filter((slot) => slotIsBookable(slot) && !slotBlocked(slot, blocks.blocks)),
  };
}

function windowForSlot(slotKey: string, managerId: string): InquiryWindow | null {
  const startMs = slotStartMs(slotKey);
  if (startMs === null) return null;
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + 30 * 60 * 1000).toISOString(),
    slotKey,
    adminUserId: managerId,
  };
}

/** The merged inquiries singleton row (the platform-wide read-merge-write pattern). */
function inquiriesSingletonRecord(payload: InquiryPayloadRow[]): Record<string, unknown> {
  return {
    id: INQUIRIES_RECORD_ID,
    manager_user_id: null,
    property_id: null,
    record_type: INQUIRIES_RECORD_ID,
    row_data: {
      id: INQUIRIES_RECORD_ID,
      recordType: INQUIRIES_RECORD_ID,
      managerUserId: null,
      propertyId: null,
      payload,
    },
    updated_at: new Date().toISOString(),
  };
}

/**
 * One upsert statement for the singleton AND the standalone record, so the
 * payload row and the calendar/conflict record it claims can never disagree:
 * either both land or neither does. A slot colliding with
 * `portal_schedule_tour_manager_slot_unique` therefore fails the whole write
 * instead of storing an inquiry that blocks nothing.
 */
async function writeInquiryRecords(db: Db, records: Record<string, unknown>[]): Promise<boolean> {
  const { error } = await db.from("portal_schedule_records").upsert(records, { onConflict: "id" });
  if (error) console.error("sms-intent-router inquiry write failed", error.message);
  return !error;
}

/**
 * EXACTLY ONE standalone record per inquiry, always index `_0`, carrying the
 * full payload — every offered window included.
 *
 * A multi-window offer does not need a record per window: both readers of these
 * rows (`loadManagerTourBlocksResult` and the public availability route) expand
 * `windowsFromPayload(payload)`, so the single `_0` record already blocks every
 * requested window. Writing `_1`/`_2` as well would leak them forever, because
 * the shared accept path (`tour-inquiry-confirm.server.ts`) and the portal
 * delete route only ever remove `_0` — the web booking page offers one window,
 * so nothing else has ever written a higher index. Orphaned records keep their
 * windows blocked on the public grid and permanently occupy
 * `(manager_user_id, starts_at)` on the partial unique index.
 */
function standaloneRecordsFor(row: InquiryPayloadRow, windows: InquiryWindow[]): Record<string, unknown>[] {
  const first = windows[0];
  if (!first) return [];
  const recordId = `${INQUIRY_EVENT_RECORD_TYPE}_${textField(row, "id")}_0`;
  const managerUserId = textField(row, "managerUserId") || null;
  const propertyId = textField(row, "propertyId") || null;
  return [
    {
      id: recordId,
      manager_user_id: managerUserId,
      property_id: propertyId,
      record_type: INQUIRY_EVENT_RECORD_TYPE,
      starts_at: first.start,
      ends_at: first.end,
      row_data: {
        id: recordId,
        recordType: INQUIRY_EVENT_RECORD_TYPE,
        managerUserId,
        propertyId,
        payload: row,
      },
      updated_at: new Date().toISOString(),
    },
  ];
}

type CreateTourInquiryResult =
  | { status: "created"; row: InquiryPayloadRow }
  | { status: "exists"; row: InquiryPayloadRow }
  | { status: "failed" };

async function createSmsTourInquiry(
  db: Db,
  args: {
    managerId: string;
    listing: ListingRow;
    fromPhone: string;
    conversationId: string;
    inboundBody: string;
    windows: InquiryWindow[];
  },
): Promise<CreateTourInquiryResult> {
  const now = new Date().toISOString();
  const row: InquiryPayloadRow = {
    id: crypto.randomUUID(),
    kind: "tour",
    status: "pending",
    createdAt: now,
    // No name/email yet — follow-up texts fill them in; display sites fall
    // back to the phone-derived handle.
    name: "",
    email: "",
    phone: normalizePhoneE164(args.fromPhone) ?? args.fromPhone.trim(),
    // The prospect texted this number first; replying about THIS tour in the
    // same conversation is the consent they expressed. A later STOP still
    // supersedes (the transport's ledger gate wins at send time).
    smsConsent: true,
    smsConsentAt: now,
    source: "sms",
    conversationId: args.conversationId,
    managerUserId: args.managerId,
    adminUserId: args.managerId,
    propertyId: args.listing.id,
    propertyTitle: args.listing.label,
    notes: `Requested by text message: "${args.inboundBody.trim().slice(0, 280)}"`,
    tourGroupId: crypto.randomUUID(),
    requestedWindows: args.windows,
    proposedStart: args.windows[0]?.start,
    proposedEnd: args.windows[0]?.end,
  };

  // Re-read the singleton IMMEDIATELY before the write, the way the public
  // booking route does. The idempotency read happened several round trips ago
  // (slot math, tour blocks); merging onto that stale payload would silently
  // drop any inquiry created in between, and a dropped inquiry is
  // unrecoverable — its standalone records would outlive their payload row.
  const { data, error: readError } = await db
    .from("portal_schedule_records")
    .select("row_data")
    .eq("id", INQUIRIES_RECORD_ID)
    .maybeSingle();
  if (readError) {
    console.error("sms-intent-router inquiries re-read failed", readError.message);
    return { status: "failed" };
  }

  // Re-run the idempotency predicate on the payload we are about to merge onto.
  // The early check happened several round trips ago, so a double-tapped CTA or
  // a webhook retry can otherwise pass it twice and create two inquiries.
  const existing = inquiryRows(data?.row_data);
  const phoneKey = normalizeConsentPhone(args.fromPhone);
  const alreadyPending = phoneKey ? pendingTourRowIn(existing, args.managerId, phoneKey) : null;
  if (alreadyPending) return { status: "exists", row: alreadyPending };

  const stored = await writeInquiryRecords(db, [
    inquiriesSingletonRecord([row, ...existing]),
    ...standaloneRecordsFor(row, args.windows),
  ]);
  if (!stored) return { status: "failed" };

  // The inbound text is the prospect's opt-in for tour messages about this
  // conversation (consumer-initiated); a later STOP supersedes it.
  await recordOptIn(db, args.fromPhone, null, "text-to-tour").catch(() => undefined);

  // Server-confirmed funnel moment — fires only after the inquiry stored.
  track("tour_request_created", args.managerId, { channel: "sms" });

  // Same notification + approval-first hooks as a web tour request, best-effort.
  void (async () => {
    const { notifyManagerTourRequest } = await import("@/lib/tour-notification-delivery.server");
    const request = new Request(publicAppOrigin());
    await notifyManagerTourRequest(
      db,
      request,
      row as Parameters<typeof notifyManagerTourRequest>[2],
      args.windows[0],
    );
  })().catch(() => undefined);
  void (async () => {
    const { loadManagerAutomationSettings } = await import("@/lib/payment-automation-settings");
    const settings = await loadManagerAutomationSettings(db, args.managerId);
    if (!settings.proposeTourConfirmations) return;
    await proposeTourConfirmation(db, {
      inquiry: row,
      managerUserId: args.managerId,
      requestedWindows: args.windows,
    });
  })().catch(() => undefined);

  return { status: "created", row };
}

/**
 * Replace one inquiry row in the singleton and rewrite its standalone records.
 *
 * The payload is re-read here rather than merged onto the caller's earlier
 * snapshot, so a concurrent booking is never dropped. A row that has since
 * left the payload (accepted or cancelled) returns false rather than being
 * resurrected.
 *
 * Narrowing to a chosen window is a plain re-point of the single `_0` record at
 * the chosen `starts_at` — there are no `_1`/`_2` records to strand or to
 * collide with on `portal_schedule_tour_manager_slot_unique`, which is exactly
 * why {@link standaloneRecordsFor} writes only one. Any failure returns false —
 * callers must not tell the prospect it saved.
 */
async function updateSmsTourInquiry(
  db: Db,
  current: InquiryPayloadRow,
  next: InquiryPayloadRow,
): Promise<boolean> {
  const id = textField(current, "id");
  const nextWindows = windowsOf(next);

  const { data, error: readError } = await db
    .from("portal_schedule_records")
    .select("row_data")
    .eq("id", INQUIRIES_RECORD_ID)
    .maybeSingle();
  if (readError) {
    console.error("sms-intent-router inquiries re-read failed", readError.message);
    return false;
  }
  const all = inquiryRows(data?.row_data);
  if (!all.some((item) => textField(item, "id") === id)) return false;

  const nextAll = all.map((item) => (textField(item, "id") === id ? next : item));
  return writeInquiryRecords(db, [
    inquiriesSingletonRecord(nextAll),
    ...standaloneRecordsFor(next, nextWindows),
  ]);
}

/* ----------------------------------------------------------------------- */
/* Reply copy                                                               */
/* ----------------------------------------------------------------------- */

function numberedSlotLines(windows: InquiryWindow[]): string {
  return windows
    .map((w, i) => `${i + 1}) ${w.slotKey ? tourSlotLabel(w.slotKey) : smsInstantLabel(w.start)}`)
    .join("\n");
}

/** The reminder a repeat tour text gets instead of a second inquiry. */
function alreadyPendingTourReply(row: InquiryPayloadRow, fallbackLabel: string): string {
  const offered = windowsOf(row);
  const lines = numberedSlotLines(offered);
  return `You already have a tour request in for ${textField(row, "propertyTitle") || fallbackLabel} — the manager will confirm soon.${lines ? `\nRequested times:\n${lines}\n${replyPickInstruction(offered.length)}.` : ""}${contactAsk(row)}`;
}

function contactAsk(row: InquiryPayloadRow | null): string {
  const hasName = Boolean(textField(row, "name"));
  const hasEmail = Boolean(textField(row, "email"));
  if (!hasName && !hasEmail) return " Reply with your name (and email) so the manager knows who's coming.";
  if (!hasName) return " Reply with your name so the manager knows who's coming.";
  if (!hasEmail) return " Reply with your email to get a confirmation email too.";
  return "";
}

/* ----------------------------------------------------------------------- */
/* The router                                                               */
/* ----------------------------------------------------------------------- */

export async function routeInboundSms(ctx: InboundSmsContext): Promise<SmsIntentResult> {
  const body = (ctx.body ?? "").trim();
  const managerId = ctx.managerId?.trim();
  const fromPhone = ctx.fromPhone?.trim();
  if (!managerId || !fromPhone) return { handled: false };

  const db = createSupabaseServiceRoleClient();
  const keyword = body.toUpperCase();
  const origin = publicAppOrigin();

  // 1) Compliance controls come before everything, including suppression.
  if (STOP_KEYWORDS.has(keyword)) {
    await recordOptOut(db, fromPhone);
    // Silent on purpose: Twilio Advanced Opt-Out sends the carrier-required
    // confirmation, and the transport's consent gate now blocks this number.
    return { handled: true };
  }
  if (START_KEYWORDS.has(keyword)) {
    await recordOptIn(db, fromPhone, null, "sms-start");
    return { handled: true, autoReplyBody: OPT_BACK_IN_REPLY };
  }

  if (HELP_KEYWORDS.has(keyword)) {
    const helpListings = await loadManagerListings(db, managerId).catch(() => ({ ok: false }) as const);
    // Same ONE-label rule as every other reply: resolve the listing from the
    // body rather than naming the manager's most recent one, so HELP can never
    // answer about a different house than the rest of the conversation.
    const helpTarget = helpListings.ok
      ? resolveTargetListing({ body, listings: helpListings.listings }).listing
      : null;
    const label = helpTarget?.label || "the property leasing line";
    return {
      handled: true,
      autoReplyBody:
        `This is ${label} via PropLane (${origin}). Reply TOUR to schedule a tour or APPLY to start an application — or just ask a question. ` +
        `Msg&data rates may apply. Message frequency varies. Reply STOP to opt out.`,
    };
  }

  // 2) Never message an opted-out number — deliberate silence, and default
  // handling is skipped too. A bare "YES" is the carrier-standard resume.
  if (await isPhoneOptedOut(db, fromPhone)) {
    if (/^\s*yes\s*[.!]*\s*$/i.test(body)) {
      await recordOptIn(db, fromPhone, null, "sms-start");
      return { handled: true, autoReplyBody: OPT_BACK_IN_REPLY };
    }
    return { handled: true };
  }

  // 3) Once a manager is talking to this person, automated replies stop.
  if (await humanOwnsConversation(db, managerId, fromPhone, ctx.conversationId)) {
    return { handled: true };
  }

  // Reads start only once every suppression gate has passed, so a silenced
  // thread costs no queries.
  const [listingsLookup, pendingLookup] = await Promise.all([
    loadManagerListings(db, managerId).catch(() => ({ ok: false }) as const),
    findPendingTourInquiry(db, managerId, fromPhone).catch(() => ({ ok: false }) as const),
  ]);
  const listings = listingsLookup.ok ? listingsLookup.listings : [];
  const pending = pendingLookup.ok ? pendingLookup.pending : null;

  // ONE label choice drives every reply: the menu body, the compliance footer,
  // and the exported transport fallback all name the RESOLVED listing, so a
  // multi-listing manager can never see two different houses in one message.
  const { listing, unresolvedPropertyId } = resolveTargetListing({
    body,
    listings,
    pendingInquiryPropertyId: pending ? textField(pending, "propertyId") : null,
  });
  const businessLabel = listing?.label ?? null;
  const footer = ctx.isFirstMessageInConversation ? `\n\n${complianceFooter(businessLabel)}` : "";

  const finish = (reply: string): SmsIntentResult => ({
    handled: true,
    autoReplyBody: `${reply}${footer}`,
  });

  // Fall-through to the transport's default handler (leasing agent). On a
  // FIRST contact the compliance footer travels with it so the first
  // automated message still identifies the business + how to opt out.
  const fallThrough = (): SmsIntentResult =>
    ctx.isFirstMessageInConversation
      ? { handled: false, firstContactFooter: complianceFooter(businessLabel) }
      : { handled: false };

  // A listings read that FAILED is not a manager with nothing to show: telling
  // a prospect "no homes are open" is a dead end, while the real state is
  // retryable. Only the genuine empty case keeps the definitive copy.
  const lookupTroubleReply = () =>
    finish(
      `Thanks for reaching out! We're having trouble looking that up right now — please try again shortly, or browse current homes at ${origin}/rent.`,
    );
  // The prospect named an id we do not have. Say so — substituting another
  // house would file a tour or send an application link for a home they never
  // asked about.
  const unknownListingReply = () =>
    finish(
      `Thanks for reaching out! We couldn't find that listing — it may no longer be available. Browse current homes at ${origin}/rent.`,
    );
  const tourLinkReply = (target: ListingRow, lead: string) =>
    finish(`${lead} ${buildManagerTourUrl(origin, target.id)}`);

  const intent = classifyLeasingIntent(body);

  /* --- Follow-ups against the pending tour inquiry --------------------- */

  if (pending) {
    const offered = windowsOf(pending);
    const pendingTitle = textField(pending, "propertyTitle") || "the property";
    const pendingTourUrl = buildManagerTourUrl(origin, textField(pending, "propertyId"));
    const saveFailed = (what: string) =>
      finish(`Sorry — ${what} didn't save. You can update your tour request here: ${pendingTourUrl}`);

    const pick = parseSlotPick(body, offered.length);
    if (pick !== null && offered[pick]) {
      const chosen = offered[pick];
      const timeLabel = chosen.slotKey ? tourSlotLabel(chosen.slotKey) : smsInstantLabel(chosen.start);
      const updated: InquiryPayloadRow = {
        ...pending,
        requestedWindows: [chosen],
        proposedStart: chosen.start,
        proposedEnd: chosen.end,
        notes: `${textField(pending, "notes")}\nProspect chose ${timeLabel} by text.`.trim(),
      };
      const ok = await updateSmsTourInquiry(db, pending, updated);
      if (!ok) {
        return finish(`Sorry — that didn't save. Please pick your time here: ${pendingTourUrl}`);
      }
      return finish(
        `Got it — ${timeLabel} requested for ${pendingTitle}. The manager will confirm shortly.${contactAsk(updated)}`,
      );
    }

    // Same intent guard the name fill below uses: "I'd like to apply —
    // jordan@example.com" is an APPLY request that happens to carry an address.
    // Swallowing it as a tour-confirmation email answers a question the
    // prospect did not ask and never sends the wizard link they did.
    const email = intentOutranksContactFill(intent) ? null : extractEmailCandidate(body);
    if (email && !textField(pending, "email")) {
      const updated = { ...pending, email };
      if (!(await updateSmsTourInquiry(db, pending, updated))) return saveFailed("your email");
      return finish(`Thanks — we'll send your tour confirmation to ${email}.${contactAsk(updated)}`);
    }

    if (!intentOutranksContactFill(intent) && !textField(pending, "name")) {
      const name = extractNameCandidate(body);
      if (name) {
        const updated = { ...pending, name };
        if (!(await updateSmsTourInquiry(db, pending, updated))) return saveFailed("your name");
        return finish(`Thanks, ${name}! The manager will confirm your tour time shortly.${contactAsk(updated)}`);
      }
    }

    if (looksLikeAffirmation(body) || looksLikeAvailabilityQuestion(body)) {
      const lines = numberedSlotLines(offered);
      return finish(
        lines
          ? `Your tour request for ${pendingTitle} is in. Requested time${offered.length > 1 ? "s" : ""}:\n${lines}\n${offered.length > 1 ? `${replyPickInstruction(offered.length)}, or` : "Reply here to change it, or"} choose another time: ${pendingTourUrl}`
          : `Your tour request for ${pendingTitle} is in — the manager will follow up to set a time.`,
      );
    }

    // Free-form scheduling details ("Tuesday afternoon works for me") — file
    // them on the inquiry so the manager sees them when confirming.
    if (intent === "tour_details") {
      const updated: InquiryPayloadRow = {
        ...pending,
        notes: `${textField(pending, "notes")}\nProspect: ${body.slice(0, 280)}`.trim(),
      };
      if (!(await updateSmsTourInquiry(db, pending, updated))) return saveFailed("that");
      return finish(
        `Passed along to the manager — they'll confirm your tour of ${pendingTitle} shortly.${contactAsk(updated)}`,
      );
    }
  }

  /* --- Fresh intent routing -------------------------------------------- */

  if (intent === "tour") {
    if (!listing) {
      if (!listingsLookup.ok) return lookupTroubleReply();
      if (unresolvedPropertyId) return unknownListingReply();
      return finish(
        `Thanks for reaching out! No homes are open for tours right now — browse current listings at ${origin}/rent.`,
      );
    }
    // Idempotency: one pending tour request per manager + phone. A repeat
    // "tour" text reminds instead of creating a duplicate.
    if (pending) {
      return finish(alreadyPendingTourReply(pending, listing.label));
    }
    if (!pendingLookup.ok) {
      // The existing inquiries could not be read, so creating one here could
      // duplicate a pending request — send the prospect to the booking page.
      return tourLinkReply(
        listing,
        `Happy to set up a tour of ${listing.label}! Pick a time here and the manager will confirm:`,
      );
    }
    const slotLookup = await listOpenTourSlots(db, managerId, listing.id).catch(() => ({ ok: false }) as const);
    if (!slotLookup.ok) {
      // Availability is unknown, and unknown must never become the default 9-5
      // grid — that would book a real inquiry into a window this manager may
      // never have published.
      return tourLinkReply(
        listing,
        `Happy to set up a tour of ${listing.label}! Pick a time here and the manager will confirm:`,
      );
    }
    const offered = pickOfferedSlots(slotLookup.slots)
      .map((slot) => windowForSlot(slot, managerId))
      .filter((w): w is InquiryWindow => Boolean(w));
    if (offered.length === 0) {
      return tourLinkReply(
        listing,
        `Happy to set up a tour of ${listing.label}! No open windows right now — pick a time that works here and the manager will confirm:`,
      );
    }
    const created = await createSmsTourInquiry(db, {
      managerId,
      listing,
      fromPhone,
      conversationId: ctx.conversationId,
      inboundBody: body,
      windows: offered,
    });
    if (created.status === "failed") {
      // Never claim a request that didn't save.
      return tourLinkReply(
        listing,
        `Happy to set up a tour of ${listing.label}! Pick a time here and the manager will confirm:`,
      );
    }
    if (created.status === "exists") {
      return finish(alreadyPendingTourReply(created.row, listing.label));
    }
    return finish(
      `Tour request received for ${listing.label}! Next open times:\n${numberedSlotLines(offered)}\n${replyPickInstruction(offered.length)} — or pick another here: ${buildManagerTourUrl(origin, listing.id)}\nWhat name should we put on the tour?`,
    );
  }

  if (wantsWizardLink(intent)) {
    if (!listing) {
      if (!listingsLookup.ok) return lookupTroubleReply();
      if (unresolvedPropertyId) return unknownListingReply();
      return finish(
        `Thanks for your interest! Browse current homes and apply at ${origin}/rent — applications take about 10 minutes.`,
      );
    }
    const applyUrl = buildManagerApplyUrl(origin, {
      propertyId: listing.id,
      phone: normalizePhoneE164(fromPhone) ?? fromPhone,
      bundleId: intent === "bundle" ? (extractBundleIdHint(body) ?? undefined) : undefined,
    });
    return finish(
      `Great — start your application for ${listing.label} here: ${applyUrl}\nYour phone number is prefilled; it takes about 10 minutes. Want to see it first? Reply TOUR to schedule a visit.`,
    );
  }

  if (looksLikeAvailabilityQuestion(body)) {
    // Carve-out: grounded slot math the leasing agent has no tools for. Only
    // answers when the data actually loaded — a failed read falls through so
    // we never invent times from nothing.
    if (!listing || !listingsLookup.ok) return fallThrough();
    const slotLookup = await listOpenTourSlots(db, managerId, listing.id).catch(() => ({ ok: false }) as const);
    if (!slotLookup.ok) return fallThrough();
    const offered = pickOfferedSlots(slotLookup.slots);
    if (offered.length === 0) {
      return tourLinkReply(
        listing,
        `No open tour windows for ${listing.label} right now — check back or pick a time here:`,
      );
    }
    return finish(
      `Next open tour times for ${listing.label}:\n${offered.map((slot, i) => `${i + 1}) ${tourSlotLabel(slot)}`).join("\n")}\nReply TOUR to request one, or book here: ${buildManagerTourUrl(origin, listing.id)}`,
    );
  }

  if (looksLikeRentQuestion(body)) {
    // Carve-out: the listing's stored rentLabel. No listing (or a failed
    // listings read) → fall through; never invent a price.
    if (!listing || !listingsLookup.ok) return fallThrough();
    const priceLine = listing.rentLabel ? `${listing.label}: ${listing.rentLabel}. ` : "";
    return finish(
      `${priceLine}Full pricing and details: ${buildManagerListingUrl(origin, listing.id)}\nReply TOUR to see it in person or APPLY to start an application.`,
    );
  }

  if (looksLikeNotInterested(body)) {
    return finish(`No problem — text TOUR or APPLY anytime if that changes. Reply STOP to opt out of messages.`);
  }

  // A greeting or an unrecognized first contact gets the menu, so it never
  // meets silence. A QUESTION does not: the canned menu would replace the
  // grounded answer the leasing agent can give, so it falls through instead.
  if (intent === "help" || intent === "greeting" || (ctx.isFirstMessageInConversation && intent !== "question")) {
    return finish(assistantMenuBody(businessLabel));
  }

  // Nothing here answered it — let the transport's default handling
  // (e.g. the Claude leasing agent) take the turn. Opt-out and human-takeover
  // were already enforced above, so the default path inherits those gates.
  return fallThrough();
}
