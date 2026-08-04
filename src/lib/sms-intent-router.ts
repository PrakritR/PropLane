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
 *   `axis_admin_partner_inquiries_v1` payload row + standalone
 *   `partner_inquiry_request_*` records the public booking page writes), with
 *   candidate windows drawn from the SAME offering the public availability
 *   grid computes: published future slots, else the 9-5 default grid for a
 *   LIVE listing, minus pending-inquiry and booked-tour blocks
 *   (`loadManagerTourBlocks`). The manager confirms through the existing
 *   accept/proposal machinery — nothing here books a tour directly.
 * - apply intent → replies with the property's real application wizard link,
 *   phone prefilled. Deliberately NO application row is created: a draft
 *   application needs an email and a browser-held resume token, so a
 *   server-minted row would be an orphan the prospect can never resume and a
 *   guaranteed duplicate once they really apply.
 * - a greeting or otherwise unrecognized first contact → a menu that
 *   identifies the business and how to opt out, so a prospect is never met
 *   with silence.
 * - a QUESTION, first contact or not → `handled: false`, so the transport's
 *   default handler (the Claude leasing agent) answers it with grounded
 *   listing facts instead of a canned menu. The site's own "Text a question"
 *   CTA lands here.
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
 *   the default path too.
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
 * once ANY outbound message in this manager↔phone thread was authored by a
 * human (source `work_number` or `relay` — the portal composer and the
 * manager-cell relay), automated replies stop for that thread permanently.
 * Bot traffic always logs `source: "automated"`, so a single manager reply
 * flips the thread to human-owned and this router goes silent.
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
import { loadManagerTourBlocks, proposeTourConfirmation } from "@/lib/tour-proposal.server";
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
  conversationId: string;
  isFirstMessageInConversation: boolean;
};

export type SmsIntentResult = {
  handled: boolean; // true = this router produced the outcome; default handling is skipped
  autoReplyBody?: string; // the automated response to send back, if any
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

/**
 * A short human-name-looking message ("Jane Doe", "name: Jane"). Only consulted
 * when a pending SMS tour inquiry is still nameless and nothing else matched,
 * so a false positive costs a name field, never a wrong action.
 */
export function extractNameCandidate(body: string): string | null {
  const explicit = /^\s*(?:my\s+name\s+is|name\s*[:=-])\s*(.{2,60})$/i.exec(body.trim());
  const raw = (explicit ? explicit[1] : body).trim().replace(/[.!]+$/, "");
  if (!raw || raw.length > 60) return null;
  if (/[@\d]/.test(raw)) return null;
  const words = raw.split(/\s+/);
  if (words.length < 1 || words.length > 4) return null;
  if (!words.every((w) => /^[A-Za-z][A-Za-z'’.-]*$/.test(w))) return null;
  const lowered = raw.toLowerCase();
  // Never mistake intent/answer words for a name.
  if (
    /\b(tour|apply|application|stop|help|start|yes|yeah|no|nope|ok|okay|sure|thanks|thank|rent|price|time|times|when|what|how|info|hi|hello|hey|maybe|tomorrow|today|morning|afternoon|evening)\b/.test(
      lowered,
    )
  ) {
    return null;
  }
  return explicit ? raw : words.length >= 2 ? raw : null;
}

/** "what times…", "when can I…", "availability?" — asking for tour windows. */
export function looksLikeAvailabilityQuestion(body: string): boolean {
  const t = body.trim().toLowerCase();
  return (
    /\b(what|which|wat)\s+(times?|days?|slots?)\b/.test(t) ||
    /\bwhen\s+(can|could|is|are|do)\b/.test(t) ||
    /\bavailab(le|ility)\b/.test(t) ||
    /^\s*times?\??\s*$/.test(t)
  );
}

/** "how much is rent", "price?", "monthly cost" — asking what it costs. */
export function looksLikeRentQuestion(body: string): boolean {
  const t = body.trim().toLowerCase();
  return /\bhow\s+much\b/.test(t) || /\b(rent|price|pricing|cost)\b/.test(t);
}

/** "yes" / "ok" / "sure" — an affirmative continuation, not an intent of its own. */
export function looksLikeAffirmation(body: string): boolean {
  return /^\s*(yes|yeah|yep|ya|ok|okay|sure|sounds good|that works)\s*[.!]*\s*$/i.test(body);
}

export function looksLikeNotInterested(body: string): boolean {
  return /^\s*(no|nope|no thanks|not interested|no thank you)\s*[.!]*\s*$/i.test(body);
}

/** Pacific wall-clock label for a slot key, e.g. "Aug 5, 10:00 AM". */
export function tourSlotLabel(slotKey: string): string {
  const ms = slotStartMs(slotKey);
  return ms === null ? "that time" : formatPacificDateTime(new Date(ms));
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
 * The full first-contact menu reply, footer included. The router uses this copy
 * for a greeting/unrecognized first contact; the transport may also send it as
 * a last-resort body when its own default handler (the leasing agent) throws,
 * so a first contact is never met with silence.
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

async function loadManagerListings(db: Db, managerId: string): Promise<ListingRow[]> {
  const { data } = await db
    .from("manager_property_records")
    .select("id, status, property_data")
    .eq("manager_user_id", managerId)
    .eq("status", "live")
    .order("updated_at", { ascending: false })
    .limit(50);
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
  return out;
}

/**
 * The listing this message is about, scoped to THIS manager's LIVE records
 * (the only publicly reachable status): explicit id hint, then label hint
 * (exact beats partial), then the
 * pending inquiry's property, then the manager's only/most recent listing.
 * The last fallback can guess wrong for a multi-listing manager, so every
 * reply NAMES the resolved property — a wrong guess is visible and
 * correctable, never silent.
 */
export function resolveTargetListing(args: {
  body: string;
  listings: ListingRow[];
  pendingInquiryPropertyId?: string | null;
}): ListingRow | null {
  const { body, listings } = args;
  if (listings.length === 0) return null;

  const idHint = extractPropertyIdHint(body);
  if (idHint) {
    const hit = listings.find((l) => l.id === idHint || safePropertyId(l.id) === safePropertyId(idHint));
    if (hit) return hit;
  }

  const labelHint = extractPropertyLabelHint(body)?.toLowerCase();
  if (labelHint) {
    const exact = listings.find((l) => l.label.toLowerCase() === labelHint);
    if (exact) return exact;
    const partial = listings.find((l) => {
      const label = l.label.toLowerCase();
      return label.includes(labelHint) || labelHint.includes(label);
    });
    if (partial) return partial;
  }

  const pendingId = args.pendingInquiryPropertyId?.trim();
  if (pendingId) {
    const pending = listings.find((l) => l.id === pendingId);
    if (pending) return pending;
  }

  return listings[0] ?? null;
}

/** True when a human manager has ever replied in this manager↔phone thread. */
async function humanOwnsConversation(db: Db, managerId: string, fromPhone: string): Promise<boolean> {
  const { data } = await db
    .from("manager_sms_messages")
    .select("id")
    .eq("manager_user_id", managerId)
    .in("resident_phone", profilePhoneVariants(fromPhone))
    .eq("direction", "outbound")
    .neq("source", "automated")
    .limit(1);
  return (data ?? []).length > 0;
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

function windowsOf(row: InquiryPayloadRow): InquiryWindow[] {
  const requested = Array.isArray(row.requestedWindows) ? row.requestedWindows : [];
  return requested
    .map(asObject)
    .filter((w): w is Record<string, unknown> => Boolean(w))
    .map((w) => ({
      start: textField(w, "start"),
      end: textField(w, "end"),
      slotKey: textField(w, "slotKey"),
      adminUserId: textField(w, "adminUserId"),
    }))
    .filter((w) => w.start && w.end);
}

/**
 * The one pending tour inquiry for this manager + prospect phone — an
 * IDEMPOTENCY check only. The payload it read is deliberately not returned:
 * every writer re-reads the singleton immediately before merging, so a stale
 * snapshot can never become a write base.
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
  const row = inquiryRows(data?.row_data).find(
    (item) =>
      textField(item, "kind") === "tour" &&
      textField(item, "status").toLowerCase() === "pending" &&
      textField(item, "managerUserId") === managerId &&
      normalizeConsentPhone(textField(item, "phone")) === phoneKey,
  );
  return { ok: true, pending: row ?? null };
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
 */
async function listOpenTourSlots(db: Db, managerId: string, propertyId: string): Promise<string[]> {
  const { data } = await db
    .from("portal_schedule_records")
    .select("property_id, record_type, row_data")
    .eq("manager_user_id", managerId)
    .in("record_type", ["manager_property_availability", "manager_availability"]);

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

  const blocks = await loadManagerTourBlocks(db, managerId);
  return [...new Set(base)].filter((slot) => slotIsBookable(slot) && !slotBlocked(slot, blocks));
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
 * One upsert statement for the singleton AND the per-window records, so the
 * payload row and the calendar/conflict records it claims can never disagree:
 * either both land or neither does. A slot colliding with
 * `portal_schedule_tour_manager_slot_unique` therefore fails the whole write
 * instead of storing an inquiry that blocks nothing.
 */
async function writeInquiryRecords(db: Db, records: Record<string, unknown>[]): Promise<boolean> {
  const { error } = await db.from("portal_schedule_records").upsert(records, { onConflict: "id" });
  if (error) console.error("sms-intent-router inquiry write failed", error.message);
  return !error;
}

function standaloneRecordsFor(row: InquiryPayloadRow, windows: InquiryWindow[]): Record<string, unknown>[] {
  const id = textField(row, "id");
  const managerUserId = textField(row, "managerUserId") || null;
  const propertyId = textField(row, "propertyId") || null;
  return windows.map((window, index) => ({
    id: `${INQUIRY_EVENT_RECORD_TYPE}_${id}_${index}`,
    manager_user_id: managerUserId,
    property_id: propertyId,
    record_type: INQUIRY_EVENT_RECORD_TYPE,
    starts_at: window.start,
    ends_at: window.end,
    row_data: {
      id: `${INQUIRY_EVENT_RECORD_TYPE}_${id}_${index}`,
      recordType: INQUIRY_EVENT_RECORD_TYPE,
      managerUserId,
      propertyId,
      payload: row,
    },
    updated_at: new Date().toISOString(),
  }));
}

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
): Promise<InquiryPayloadRow | null> {
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
    return null;
  }

  const stored = await writeInquiryRecords(db, [
    inquiriesSingletonRecord([row, ...inquiryRows(data?.row_data)]),
    ...standaloneRecordsFor(row, args.windows),
  ]);
  if (!stored) return null;

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

  return row;
}

/**
 * Replace one inquiry row in the singleton and rewrite its standalone records.
 *
 * The payload is re-read here rather than merged onto the caller's earlier
 * snapshot, so a concurrent booking is never dropped. A row that has since
 * left the payload (accepted or cancelled) returns false rather than being
 * resurrected.
 *
 * Narrowing to a chosen window RE-POINTS record `_0` at a `starts_at` that
 * records `_1`/`_2` still hold, so the stale records must be deleted BEFORE the
 * upsert or `portal_schedule_tour_manager_slot_unique` rejects the whole write.
 * Any failure returns false — callers must not tell the prospect it saved.
 */
async function updateSmsTourInquiry(
  db: Db,
  current: InquiryPayloadRow,
  next: InquiryPayloadRow,
): Promise<boolean> {
  const id = textField(current, "id");
  const previousWindows = windowsOf(current);
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

  if (previousWindows.length > nextWindows.length) {
    const staleIds = previousWindows
      .map((_, index) => `${INQUIRY_EVENT_RECORD_TYPE}_${id}_${index}`)
      .slice(nextWindows.length);
    const { error: deleteError } = await db.from("portal_schedule_records").delete().in("id", staleIds);
    if (deleteError) {
      console.error("sms-intent-router stale window delete failed", deleteError.message);
      return false;
    }
  }

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
    .map((w, i) => `${i + 1}) ${w.slotKey ? tourSlotLabel(w.slotKey) : formatPacificDateTime(w.start)}`)
    .join("\n");
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
    const helpListings = await loadManagerListings(db, managerId).catch(() => [] as ListingRow[]);
    const label = helpListings[0]?.label || "the property leasing line";
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
  if (await humanOwnsConversation(db, managerId, fromPhone)) {
    return { handled: true };
  }

  // Reads start only once every suppression gate has passed, so a silenced
  // thread costs no queries.
  const [listings, pendingLookup] = await Promise.all([
    loadManagerListings(db, managerId).catch(() => [] as ListingRow[]),
    findPendingTourInquiry(db, managerId, fromPhone).catch(() => ({ ok: false }) as const),
  ]);
  const pending = pendingLookup.ok ? pendingLookup.pending : null;
  const footer = ctx.isFirstMessageInConversation
    ? `\n\n${complianceFooter(listings[0]?.label ?? null)}`
    : "";

  const finish = (reply: string): SmsIntentResult => ({
    handled: true,
    autoReplyBody: `${reply}${footer}`,
  });

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
      const timeLabel = chosen.slotKey ? tourSlotLabel(chosen.slotKey) : formatPacificDateTime(chosen.start);
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

    const email = extractEmailCandidate(body);
    if (email && !textField(pending, "email")) {
      const updated = { ...pending, email };
      if (!(await updateSmsTourInquiry(db, pending, updated))) return saveFailed("your email");
      return finish(`Thanks — we'll send your tour confirmation to ${email}.${contactAsk(updated)}`);
    }

    if (intent !== "tour" && intent !== "apply" && !textField(pending, "name")) {
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

  const listing = resolveTargetListing({
    body,
    listings,
    pendingInquiryPropertyId: pending ? textField(pending, "propertyId") : null,
  });

  if (intent === "tour") {
    if (!listing) {
      return finish(
        `Thanks for reaching out! No homes are open for tours right now — browse current listings at ${origin}/rent.`,
      );
    }
    // Idempotency: one pending tour request per manager + phone. A repeat
    // "tour" text reminds instead of creating a duplicate.
    if (pending) {
      const offered = windowsOf(pending);
      const lines = numberedSlotLines(offered);
      return finish(
        `You already have a tour request in for ${textField(pending, "propertyTitle") || listing.label} — the manager will confirm soon.${lines ? `\nRequested times:\n${lines}\n${replyPickInstruction(offered.length)}.` : ""}${contactAsk(pending)}`,
      );
    }
    if (!pendingLookup.ok) {
      // The existing inquiries could not be read, so creating one here could
      // duplicate a pending request — send the prospect to the booking page.
      return finish(
        `Happy to set up a tour of ${listing.label}! Pick a time here and the manager will confirm: ${buildManagerTourUrl(origin, listing.id)}`,
      );
    }
    const openSlots = await listOpenTourSlots(db, managerId, listing.id).catch(() => [] as string[]);
    const offered = pickOfferedSlots(openSlots)
      .map((slot) => windowForSlot(slot, managerId))
      .filter((w): w is InquiryWindow => Boolean(w));
    if (offered.length === 0) {
      return finish(
        `Happy to set up a tour of ${listing.label}! No open windows right now — pick a time that works here and the manager will confirm: ${buildManagerTourUrl(origin, listing.id)}`,
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
    if (!created) {
      // Never claim a request that didn't save.
      return finish(
        `Happy to set up a tour of ${listing.label}! Pick a time here and the manager will confirm: ${buildManagerTourUrl(origin, listing.id)}`,
      );
    }
    return finish(
      `Tour request received for ${listing.label}! Next open times:\n${numberedSlotLines(offered)}\n${replyPickInstruction(offered.length)} — or pick another here: ${buildManagerTourUrl(origin, listing.id)}\nWhat name should we put on the tour?`,
    );
  }

  if (intent === "apply" || intent === "bundle") {
    if (!listing) {
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
    if (!listing) {
      return finish(`No tour windows are open right now — browse current listings at ${origin}/rent.`);
    }
    const openSlots = await listOpenTourSlots(db, managerId, listing.id).catch(() => [] as string[]);
    const offered = pickOfferedSlots(openSlots);
    if (offered.length === 0) {
      return finish(
        `No open tour windows for ${listing.label} right now — check back or pick a time here: ${buildManagerTourUrl(origin, listing.id)}`,
      );
    }
    return finish(
      `Next open tour times for ${listing.label}:\n${offered.map((slot, i) => `${i + 1}) ${tourSlotLabel(slot)}`).join("\n")}\nReply TOUR to request one, or book here: ${buildManagerTourUrl(origin, listing.id)}`,
    );
  }

  if (looksLikeRentQuestion(body) && listing) {
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
    return finish(assistantMenuBody(listing?.label ?? null));
  }

  // Nothing here answered it — let the transport's default handling
  // (e.g. the Claude leasing agent) take the turn. Opt-out and human-takeover
  // were already enforced above, so the default path inherits those gates.
  return { handled: false };
}
