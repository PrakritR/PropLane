/**
 * Leasing SMS auto-replies for a manager's Twilio work number.
 *
 * Prospects text the manager's `sms_from_number` about tours / applications;
 * we reply with deep links (apply) or intake questions (tour) and mirror the
 * thread into that manager's PropLane inbox. Claw Messenger is opt-in legacy only.
 */

import { after } from "next/server";
import {
  buildManagerApplyUrl,
  buildManagerListingUrl,
  buildManagerTourUrl,
  buildPropertyMessageHref,
} from "@/lib/manager-property-links";
import { residentPortalUrl } from "@/lib/claw-resident-links";
import {
  classifyLeasingIntent,
  clawLeasingAgentPhoneE164,
  extractBundleIdHint,
  extractBundleLabelHint,
  extractPropertyIdHint,
  extractPropertyLabelHint,
  looksLikeProspectLeasingCta,
  type LeasingIntent,
} from "@/lib/claw-leasing-links";
import { normalizeE164Us } from "@/lib/claw-messenger.server";
import {
  forwardClawInboundToManagers,
  isMappedManagerPhone,
  tryRelayManagerReplyViaClaw,
} from "@/lib/claw-relay.server";
import {
  findResidentProfileByPhone,
  findThreadByResidentPhone,
  forwardResidentMessageToManagers,
  mirrorResidentTextToManagerInbox,
  openClawResidentThread,
  resolveMappedManagerContacts,
} from "@/lib/claw-resident-messaging.server";
import { buildManagerResidentBrief, runResidentSmsAction } from "@/lib/claw-resident-actions.server";
import {
  sendFromManagerWorkNumber,
  sendPropLaneSms,
  type PropLaneSmsResult,
} from "@/lib/proplane-sms-transport.server";
import { buildConversationKey, type SmsCounterpartyRole } from "@/lib/sms-conversation-identity";
import { recordScopedSmsConsent } from "@/lib/sms-consent";
import { upsertManagerInboxNotice } from "@/lib/sms-inbox-notice.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { normalizeE164 } from "@/lib/twilio";
import { PRODUCTION_APP_ORIGIN } from "@/lib/app-url";

export {
  buildSmsDeepLink,
  classifyLeasingIntent,
  extractBundleIdHint,
  extractPropertyIdHint,
  looksLikeProspectLeasingCta,
  type LeasingIntent,
} from "@/lib/claw-leasing-links";

export { clawMappedManagerEmails } from "@/lib/claw-resident-messaging.server";

export function publicAppOrigin(): string {
  // Agent-generated SMS must use the branded canonical origin even if a
  // legacy host is still configured for compatibility elsewhere.
  return PRODUCTION_APP_ORIGIN;
}

type ManagerTarget = {
  userId: string;
  email: string;
  fullName: string | null;
  defaultPropertyId: string | null;
  defaultPropertyLabel: string | null;
};

type PropertyHint = { propertyId: string; propertyLabel: string | null; managerUserId?: string | null };

/**
 * Managers who participate in the shared Claw line — DB-driven registration
 * (`resolveRegisteredClawManagers`, sandbox-excluded), ordered oldest-first so
 * `managers[0]` is a deterministic anchor for session/escalation/notice
 * routing when an inbound text names no specific listing. Cross-catalog
 * listing lookup does not depend on this ordering (any registered manager's
 * matched listing wins via the property hint), but this IS the choke point
 * that keeps demo/test accounts out of the shared line entirely.
 */
async function resolveMappedManagers(): Promise<ManagerTarget[]> {
  const contacts = await resolveMappedManagerContacts();
  if (contacts.length === 0) return [];
  const db = createSupabaseServiceRoleClient();

  const out: ManagerTarget[] = [];
  for (const contact of contacts) {
    const { data: props } = await db
      .from("manager_property_records")
      .select("id, property_data, status")
      .eq("manager_user_id", contact.userId)
      .in("status", ["live", "listed"])
      .order("updated_at", { ascending: false })
      .limit(1);

    const first = props?.[0] as
      | { id?: string; property_data?: { title?: string; address?: string; buildingName?: string } | null }
      | undefined;
    const propertyId = first?.id?.trim() || null;
    const label =
      first?.property_data?.buildingName?.trim() ||
      first?.property_data?.title?.trim() ||
      first?.property_data?.address?.trim() ||
      null;

    out.push({
      userId: contact.userId,
      email: contact.email,
      fullName: contact.fullName,
      defaultPropertyId: propertyId,
      defaultPropertyLabel: label,
    });
  }
  return out;
}

/** Resolve a single manager (Twilio work-number inbound) into leasing targets. */
async function resolveManagerTarget(managerUserId: string): Promise<ManagerTarget[]> {
  const uid = managerUserId.trim();
  if (!uid) return [];
  const db = createSupabaseServiceRoleClient();
  const { data: profile } = await db
    .from("profiles")
    .select("id, email, full_name")
    .eq("id", uid)
    .maybeSingle();
  if (!profile) return [];

  const { data: props } = await db
    .from("manager_property_records")
    .select("id, property_data, status")
    .eq("manager_user_id", uid)
    .in("status", ["live", "listed"])
    .order("updated_at", { ascending: false })
    .limit(1);

  const first = props?.[0] as
    | { id?: string; property_data?: { title?: string; address?: string; buildingName?: string } | null }
    | undefined;
  const propertyId = first?.id?.trim() || null;
  const label =
    first?.property_data?.buildingName?.trim() ||
    first?.property_data?.title?.trim() ||
    first?.property_data?.address?.trim() ||
    null;

  return [
    {
      userId: uid,
      email: String((profile as { email?: unknown }).email ?? "").trim().toLowerCase(),
      fullName: String((profile as { full_name?: unknown }).full_name ?? "").trim() || null,
      defaultPropertyId: propertyId,
      defaultPropertyLabel: label,
    },
  ];
}

/**
 * A per-manager Twilio work number is scoped to exactly ONE manager — do NOT
 * also accept any other registered shared-line manager here (that shortcut
 * made sense when the shared-line roster was 2-3 trial accounts; now that
 * it's DB-driven over every real manager, it would let any manager's phone be
 * recognized as staff on a DIFFERENT manager's dedicated number, breaking the
 * per-manager isolation this scoped path exists for). The shared Claw line's
 * own inbound path already checks `isMappedManagerPhone` directly.
 */
async function isManagerPersonalPhone(fromE164: string, managerUserId: string): Promise<boolean> {
  const db = createSupabaseServiceRoleClient();
  const { data } = await db
    .from("profiles")
    .select("phone, phone_verified_at")
    .eq("id", managerUserId)
    .maybeSingle();
  const personal = normalizeE164Us(String((data as { phone?: unknown } | null)?.phone ?? ""));
  const verified = Boolean((data as { phone_verified_at?: string | null } | null)?.phone_verified_at);
  return Boolean(personal && personal === fromE164 && verified);
}

async function replySms(args: {
  to: string;
  text: string;
  managerUserId?: string | null;
  workNumber?: string | null;
  residentUserId?: string | null;
  residentEmail?: string | null;
  counterpartyRole?: SmsCounterpartyRole;
  conversationKey?: string | null;
  dedupeKey?: string | null;
}): Promise<PropLaneSmsResult> {
  if (args.managerUserId) {
    return sendFromManagerWorkNumber({
      managerUserId: args.managerUserId,
      to: args.to,
      text: args.text,
      fromNumber: args.workNumber,
      residentUserId: args.residentUserId,
      residentEmail: args.residentEmail,
      counterpartyRole: args.counterpartyRole,
      conversationKey: args.conversationKey,
      dedupeKey: args.dedupeKey,
    });
  }
  return sendPropLaneSms({ to: args.to, text: args.text, fromNumber: args.workNumber });
}

async function resolvePropertyHint(
  propertyId: string | null,
  managers: ManagerTarget[],
): Promise<PropertyHint | null> {
  const id = propertyId?.trim();
  if (!id || managers.length === 0) return null;
  const db = createSupabaseServiceRoleClient();
  // Untrusted SMS token: only ever resolve to a mapped manager's LISTED
  // property — never confirm or link other landlords' (or unlisted) records.
  const { data } = await db
    .from("manager_property_records")
    .select("id, property_data, manager_user_id")
    .eq("id", id)
    .in(
      "manager_user_id",
      managers.map((m) => m.userId),
    )
    .in("status", ["live", "listed"])
    .maybeSingle();
  if (!data) return null;
  const pd = (data as { property_data?: { title?: string; address?: string; buildingName?: string } | null })
    .property_data;
  const label = pd?.buildingName?.trim() || pd?.title?.trim() || pd?.address?.trim() || null;
  return {
    propertyId: id,
    propertyLabel: label,
    managerUserId: String((data as { manager_user_id?: unknown }).manager_user_id ?? "").trim() || null,
  };
}

function propertyDisplayLabel(pd: { title?: string; address?: string; buildingName?: string } | null | undefined): string {
  return pd?.buildingName?.trim() || pd?.title?.trim() || pd?.address?.trim() || "";
}

async function resolvePropertyByLabelHint(
  labelHint: string | null,
  managers: ManagerTarget[],
): Promise<PropertyHint | null> {
  const needle = (labelHint ?? "").trim().toLowerCase();
  if (!needle) return null;

  const score = (label: string): "exact" | "partial" | null => {
    const lower = label.toLowerCase();
    if (lower === needle) return "exact";
    if (needle.includes(lower) || lower.includes(needle)) return "partial";
    return null;
  };

  let best: PropertyHint | null = null;

  if (managers.length > 0) {
    const db = createSupabaseServiceRoleClient();
    const { data } = await db
      .from("manager_property_records")
      .select("id, property_data, manager_user_id, status")
      .in(
        "manager_user_id",
        managers.map((m) => m.userId),
      )
      .in("status", ["live", "listed"])
      .limit(100);

    for (const row of data ?? []) {
      const id = String((row as { id?: unknown }).id ?? "").trim();
      const pd = (row as { property_data?: { title?: string; address?: string; buildingName?: string } | null })
        .property_data;
      const label = propertyDisplayLabel(pd);
      if (!id || !label) continue;
      const hit = score(label);
      if (!hit) continue;
      best = {
        propertyId: id,
        propertyLabel: label,
        managerUserId: String((row as { manager_user_id?: unknown }).manager_user_id ?? "").trim() || null,
      };
      if (hit === "exact") return best;
    }
  }

  // Shared-line fallback: search the public catalog (any owner) so a prospect
  // naming "4709A" is not stuck on managers[0]'s demo Ballard Commons listing.
  try {
    const { getPublicListings } = await import("@/lib/public-listings.server");
    const listings = await getPublicListings();
    for (const p of listings) {
      const label =
        String(p.buildingName ?? "").trim() ||
        String(p.title ?? "").trim() ||
        String(p.address ?? "").trim();
      if (!label || !p.id) continue;
      const hit = score(label);
      if (!hit) continue;
      const candidate: PropertyHint = {
        propertyId: String(p.id).trim(),
        propertyLabel: label,
        managerUserId: p.managerUserId?.trim() || null,
      };
      if (hit === "exact") return candidate;
      if (!best) best = candidate;
    }
  } catch (e) {
    console.error("resolvePropertyByLabelHint public catalog failed", e);
  }

  return best;
}

async function resolveBundleIdByLabel(propertyId: string | null, bundleLabel: string | null): Promise<string | null> {
  const pid = propertyId?.trim();
  const needle = (bundleLabel ?? "").trim().toLowerCase();
  if (!pid || !needle) return null;
  const db = createSupabaseServiceRoleClient();
  const { data } = await db
    .from("manager_property_records")
    .select("property_data")
    .eq("id", pid)
    .maybeSingle();
  const pd = (data as { property_data?: { listingSubmission?: { bundles?: Array<{ id?: string; label?: string; name?: string }> } } | null })
    ?.property_data;
  const bundles = pd?.listingSubmission?.bundles ?? [];
  for (const b of bundles) {
    const label = (b.label ?? b.name ?? "").trim().toLowerCase();
    const id = (b.id ?? "").trim();
    if (id && label && (label === needle || label.includes(needle) || needle.includes(label))) return id;
  }
  return null;
}

/** Pure reply builder — exported for unit tests. */
export function replyForIntent(args: {
  intent: LeasingIntent;
  origin: string;
  propertyId: string | null;
  propertyLabel: string | null;
  bundleId?: string | null;
  /** Prospect phone for apply-link prefill. */
  phone?: string | null;
  listingRoomId?: string | null;
  roomName?: string | null;
}): string {
  const { intent, origin, propertyId, propertyLabel } = args;
  const bundleId = args.bundleId?.trim() || null;
  const phone = args.phone?.trim() || null;
  const listingRoomId = args.listingRoomId?.trim() || undefined;
  const roomName = args.roomName?.trim() || undefined;
  const where = propertyLabel ? ` for ${propertyLabel}` : "";
  const apply = propertyId
    ? buildManagerApplyUrl(origin, {
        propertyId,
        bundleId: bundleId || undefined,
        phone: phone || undefined,
        listingRoomId,
        roomName,
      })
    : `${origin}/rent/apply`;
  const listing = propertyId ? buildManagerListingUrl(origin, propertyId) : `${origin}/rent`;
  const tour = propertyId ? buildManagerTourUrl(origin, propertyId) : `${origin}/rent`;
  const message = propertyId
    ? `${origin.replace(/\/$/, "")}${buildPropertyMessageHref(propertyId)}`
    : null;
  const leasePortal = residentPortalUrl("lease");
  const signup = residentPortalUrl("signup");

  switch (intent) {
    case "tour":
      return [
        `Thanks for reaching out${where} — happy to help schedule a tour.`,
        `Pick a time here: ${tour}`,
        `Or reply with your name, email, 2–3 times that work, and which room (or “not sure yet”). We’ll confirm shortly.`,
      ].join("\n");
    case "tour_details":
      return [
        `Got your tour details${where} — thanks!`,
        `The property manager will confirm a time soon.`,
        `Tour page: ${tour}`,
        `Want to start an application while you wait? ${apply}`,
      ].join("\n");
    case "apply":
      return [
        `Great — you can apply${where} here:`,
        apply,
        `Prefer to see it first? Book a tour: ${tour}`,
        `Reply if you have any questions about the home.`,
      ].join("\n");
    case "bundle":
      return [
        `Here’s the room-bundle application${where}:`,
        apply,
        `Want a tour of the home first? ${tour}`,
        `Text back anytime with questions.`,
      ].join("\n");
    case "question":
      return [
        `Thanks for the question${where}. I’m pulling the details and the manager has been notified.`,
        message ? `You can also leave more detail here: ${message}` : null,
        `Tour: ${tour}`,
        `Apply: ${apply}`,
      ]
        .filter(Boolean)
        .join("\n");
    case "lease":
      return [
        `You can review and sign your lease here:`,
        leasePortal,
        `Need a PropLane account first? ${signup}`,
      ].join("\n");
    case "greeting":
    case "help":
      return [
        `Hi${where ? ` — thanks for texting about ${propertyLabel}` : ""}! I’m the PropLane leasing assistant.`,
        `I can help with tours, applications, and lease signing.`,
        `Tour: ${tour}`,
        `Apply: ${apply}`,
        propertyId ? `Listing: ${listing}` : `Browse homes: ${origin}/rent`,
      ].join("\n");
    default:
      return [
        `Thanks for your message${where}. I’ve notified the property manager and can help right away.`,
        `Reply with tour or apply and I’ll send the right link — or ask about rent, rooms, or availability.`,
        `Tour: ${tour}`,
        `Apply: ${apply}`,
      ].join("\n");
  }
}

export type HandleClawInboundResult = {
  ok: boolean;
  intent: LeasingIntent;
  replied: boolean;
  error?: string;
  outboxId?: string;
  durablyAccepted?: boolean;
};

/* In-memory idempotency for redelivered relay frames (gateway restarts, webhook
 * retries): a messageId is processed at most once per warm process per TTL. */
const SEEN_INBOUND_TTL_MS = 60 * 60 * 1000;
const seenInboundMessageIds = new Map<string, number>();

function markInboundMessageSeen(messageId: string): boolean {
  const now = Date.now();
  const prev = seenInboundMessageIds.get(messageId);
  if (prev && now - prev < SEEN_INBOUND_TTL_MS) return false;
  if (seenInboundMessageIds.size > 2000) {
    for (const [key, ts] of seenInboundMessageIds) {
      if (now - ts >= SEEN_INBOUND_TTL_MS || seenInboundMessageIds.size > 2000) {
        seenInboundMessageIds.delete(key);
      } else {
        break;
      }
    }
  }
  seenInboundMessageIds.set(messageId, now);
  return true;
}

function releaseInboundMessageClaims(messageIds: string[]): void {
  for (const messageId of messageIds) seenInboundMessageIds.delete(messageId);
}

/** Test-only: clear in-memory inbound dedupe between vitest cases. */
export function __resetClawInboundSeenForTests(): void {
  seenInboundMessageIds.clear();
}

async function persistClawInboundSms(args: {
  managerUserId: string;
  residentUserId?: string | null;
  residentPhone: string;
  body: string;
  fromPhone: string;
  toPhone: string;
  messageId: string;
  /** The sender's capacity — 'resident' from the resident hub, 'prospect' from
   * the leasing responder. Splits prospect vs resident threads on one line. */
  counterpartyRole?: SmsCounterpartyRole;
}): Promise<boolean> {
  const db = createSupabaseServiceRoleClient();
  const { logManagerSmsMessage, inboundLogIdentityFields } = await import(
    "@/lib/manager-sms-messages.server"
  );
  const managerMessageLogged = await logManagerSmsMessage(db, {
    managerUserId: args.managerUserId,
    residentUserId: args.residentUserId,
    residentPhone: args.residentPhone,
    direction: "inbound",
    body: args.body,
    fromPhone: args.fromPhone,
    toPhone: args.toPhone,
    messageSid: args.messageId || null,
    source: "automated",
    counterpartyRole: args.counterpartyRole,
  });
  const { error } = await db.from("inbound_sms_log").insert({
    manager_user_id: args.managerUserId,
    from_phone: args.fromPhone,
    to_phone: args.toPhone,
    body: args.body,
    message_sid: args.messageId || null,
    matched_sender_user_id: args.residentUserId?.trim() || null,
    ...inboundLogIdentityFields({
      managerUserId: args.managerUserId,
      counterpartyRole: args.counterpartyRole,
      counterpartyUserId: args.residentUserId,
      fromPhone: args.fromPhone,
    }),
  });
  const inboundLogStored = !error || error.code === "23505";
  if (!inboundLogStored) {
    console.error("claw inbound_sms_log insert failed", error.message);
  }
  if (inboundLogStored) {
    const role = args.counterpartyRole ?? (args.residentUserId ? "resident" : "prospect");
    const conversationKey = buildConversationKey({
      ownerManagerUserId: args.managerUserId,
      role,
      counterpartyUserId: args.residentUserId,
      counterpartyPhone: args.residentPhone,
    });
    const scopedConsent = await recordScopedSmsConsent(db, args.residentPhone, {
      managerUserId: args.managerUserId,
      messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID?.trim() ?? null,
      purpose: "manager_conversation",
      sendClass: "transactional",
      conversationKey,
      eventType: "granted",
      source: "recipient_initiated_inbound",
    });
    if (!scopedConsent.ok) {
      console.error("claw inbound scoped consent insert failed", scopedConsent.error);
      return false;
    }
  }
  return managerMessageLogged && inboundLogStored;
}

/** Run manager forwards / inbox mirrors after the reply is out the door.
 * after() needs a live request scope — outside one (tests) run inline. */
function runAfterReply(task: () => Promise<unknown>): void {
  const safe = () => task().catch((e) => console.error("claw deferred task failed", e));
  try {
    after(safe);
  } catch {
    void safe();
  }
}

/**
 * Process one inbound PropLane text (Twilio work number or legacy Claw).
 * Order: manager relay → known resident messaging → leasing auto-reply.
 *
 * When `managerUserId` + `workNumber` are set (Twilio inbound), routing is
 * scoped to that manager — any From phone is accepted (no Claw allowlist).
 */
export async function handleClawLeasingInbound(args: {
  from: string;
  text: string;
  messageId?: string | null;
  mergedMessageIds?: string[];
  chatId?: string | null;
  service?: string | null;
  /** Owning manager when inbound hit their Twilio `sms_from_number`. */
  managerUserId?: string | null;
  /** E.164 work number to send replies From. */
  workNumber?: string | null;
  /** The caller owns a distributed, leased MessageSid receipt. */
  durablyClaimed?: boolean;
  /** Persist the exact reply before any provider/outbox handoff. */
  onPreparedReply?: (prepared: {
    routeKind: "leasing_agent" | "leasing_template";
    replyBody: string;
    agentSessionId?: string | null;
    inboundAgentMessageId?: string | null;
    assistantAgentMessageId?: string | null;
    turnTraceId?: string | null;
  }) => Promise<boolean>;
}): Promise<HandleClawInboundResult> {
  const from = normalizeE164Us(args.from) ?? normalizeE164(args.from);
  if (!from) return { ok: false, intent: "unknown", replied: false, error: "Invalid from phone." };

  const workNumber = args.workNumber?.trim()
    ? normalizeE164Us(args.workNumber) ?? normalizeE164(args.workNumber) ?? args.workNumber.trim()
    : null;
  // Never react to frames from the work number itself — would loop.
  if (workNumber && from === workNumber) {
    return { ok: true, intent: "unknown", replied: false };
  }

  const messageIds = [
    args.messageId,
    ...(Array.isArray(args.mergedMessageIds) ? args.mergedMessageIds : []),
  ]
    .map((id) => id?.trim() || "")
    .filter((id, index, ids) => Boolean(id) && ids.indexOf(id) === index);
  const messageId = args.messageId?.trim() || messageIds[0] || "";
  if (!args.durablyClaimed && messageId && !markInboundMessageSeen(messageId)) {
    return { ok: true, intent: "unknown", replied: false };
  }
  const claimedMessageIds = !args.durablyClaimed && messageId ? [messageId] : [];
  if (!args.durablyClaimed) {
    for (const id of messageIds) {
      if (id !== messageId && markInboundMessageSeen(id)) claimedMessageIds.push(id);
    }
  }

  const text = (args.text ?? "").trim();
  const scopedManagerId = args.managerUserId?.trim() || null;

  // Manager typing from their personal phone.
  // "agent …" commands run locally (mark paid, lease link, …) and are NOT relayed.
  // Listing CTAs (tour/apply/more info) fall through to the leasing assistant so
  // managers can test the same flow prospects see.
  // Other freeform text relays to the open resident thread.
  const fromIsManager = scopedManagerId
    ? await isManagerPersonalPhone(from, scopedManagerId)
    : await isMappedManagerPhone(from);
  if (fromIsManager && !looksLikeProspectLeasingCta(text)) {
    const { runManagerAgentCommand } = await import("@/lib/claw-manager-actions.server");
    const agent = await runManagerAgentCommand({ fromPhone: from, text });
    if (agent) {
      const send = await replySms({
        to: from,
        text: agent.reply,
        managerUserId: scopedManagerId,
        workNumber,
      });
      return {
        ok: send.ok,
        intent: "unknown",
        replied: send.ok,
        error: send.ok ? undefined : send.error,
      };
    }
    const relay = await tryRelayManagerReplyViaClaw({
      from,
      text,
      managerUserId: scopedManagerId,
      workNumber,
    });
    return {
      ok: relay.relayed || relay.error === "no_open_thread",
      intent: "unknown",
      replied: relay.relayed,
      error: relay.relayed ? undefined : relay.error,
    };
  }

  // Existing resident (payment/lease thread or known profile) → two-way messaging,
  // not the leasing auto-reply menu.
  {
    const [profileHit, existingThread] = await Promise.all([
      findResidentProfileByPhone(from),
      findThreadByResidentPhone(from),
    ]);
    let residentProfile = profileHit;
    let thread = existingThread;
    // When scoped to a work number, only continue a thread for THIS manager.
    if (thread && scopedManagerId && thread.managerUserId !== scopedManagerId) {
      thread = null;
    }
    // Resident tied to landlord A must not bind to landlord B's work number.
    if (residentProfile?.managerUserId && scopedManagerId && residentProfile.managerUserId !== scopedManagerId) {
      residentProfile = null;
      thread = null;
    }
    // The shared line can have stale threads for the same phone under another
    // landlord; the resident profile's current manager is authoritative.
    if (thread && residentProfile?.managerUserId && thread.managerUserId !== residentProfile.managerUserId) {
      thread = null;
    }
    const authoritativeManagerId =
      residentProfile?.managerUserId || (!profileHit?.managerUserId ? scopedManagerId : null);
    if (!thread && authoritativeManagerId) {
      const currentManagerThread = await findThreadByResidentPhone(from, authoritativeManagerId);
      thread =
        currentManagerThread?.managerUserId === authoritativeManagerId
          ? currentManagerThread
          : null;
    }
    // Prospect listing CTAs always hit the leasing assistant.
    // Leasing-topic threads stay on the leasing path for follow-ups (do not
    // hand off to the resident payment/lease hub after the first auto-reply).
    // Cold freeform on the shared line (no known resident) also stays leasing.
    // Non-CTA freeform from known payment/lease residents stays in the resident hub.
    const leasingThread = thread?.topic === "leasing";
    const knownResidentSender = Boolean(residentProfile) || Boolean(thread && !leasingThread);
    if (looksLikeProspectLeasingCta(text) || leasingThread || !knownResidentSender) {
      // fall through to the prospect leasing responder below
    } else if (knownResidentSender) {
    const managerForThread =
      residentProfile?.managerUserId || thread?.managerUserId || scopedManagerId || null;
    if (!thread && managerForThread) {
      thread = await openClawResidentThread({
        managerUserId: managerForThread,
        residentPhone: from,
        residentUserId: residentProfile?.userId,
        residentEmail: residentProfile?.email,
        topic: "general",
      });
      if (!thread) {
        releaseInboundMessageClaims(claimedMessageIds);
        return { ok: false, intent: "unknown", replied: false, error: "Resident SMS thread resolution failed." };
      }
    }
    if (thread) {
      const residentEmail = thread.residentEmail || residentProfile?.email || "";
      const residentUserId = thread.residentUserId || residentProfile?.userId || null;

      // Persist the resident's inbound text so Communication → SMS is a full
      // two-way replica of the Claw thread, not just the agent's outbound
      // replies — mirrors the logging already done for the leasing-prospect
      // path below. Outbound is logged for free inside replySms/sendFromManagerWorkNumber.
      const toLine = workNumber || clawLeasingAgentPhoneE164();
      const inboundLogged = await persistClawInboundSms({
        managerUserId: thread.managerUserId,
        residentUserId,
        residentPhone: from,
        body: text,
        fromPhone: from,
        toPhone: toLine,
        messageId,
        counterpartyRole: "resident",
      }).catch((e) => {
        console.error("claw resident inbound log failed", e);
        return false;
      });
      if (!inboundLogged) {
        console.error("claw resident inbound claim/consent failed; reply withheld", {
          managerUserId: thread.managerUserId,
        });
        releaseInboundMessageClaims(claimedMessageIds);
        return { ok: false, intent: "unknown", replied: false, error: "Inbound receipt unavailable." };
      }

      const action = await runResidentSmsAction({
        text,
        residentPhone: from,
        managerUserId: thread.managerUserId,
        residentUserId,
        residentEmail: residentEmail || null,
        threadTopic: thread.topic,
      });

      // Resident reply goes out first; manager forward + inbox mirror follow
      // after the response so the resident isn't waiting on them.
      const send = await replySms({
        to: from,
        text: action.residentReply,
        managerUserId: thread.managerUserId,
        workNumber,
        residentUserId,
        residentEmail: residentEmail || null,
        counterpartyRole: "resident",
        conversationKey: buildConversationKey({
          ownerManagerUserId: thread.managerUserId,
          role: "resident",
          counterpartyUserId: residentUserId,
          counterpartyPhone: from,
        }),
        dedupeKey: messageId ? `inbound_reply_${messageId}` : null,
      });

      const threadRef = thread;
      runAfterReply(async () => {
        const brief = action.classification.skipManagerBrief
          ? null
          : buildManagerResidentBrief({
              residentName: action.residentName,
              residentEmail: residentEmail || null,
              residentPhone: from,
              said: action.forwardSaid,
              wants: action.classification.wantsLabel,
              domain: action.classification.domain,
              managerPath: action.classification.managerPath,
              autoFiledNote: action.autoFiledNote,
              propertyLabel: action.propertyLabel,
              reply: action.residentReply,
            });

        const tasks: Promise<unknown>[] = [];
        if (brief) {
          tasks.push(
            forwardResidentMessageToManagers({
              fromResident: from,
              text,
              thread: threadRef,
              briefText: brief,
              workNumber,
            }),
          );
          tasks.push(
            mirrorResidentTextToManagerInbox({
              thread: threadRef,
              from,
              text,
              service: args.service,
              subject: `${action.propertyLabel ? `${action.propertyLabel} · ` : ""}${action.residentName}`,
              body: brief,
            }),
          );
        }
        if (action.threadTopic !== threadRef.topic) {
          tasks.push(
            openClawResidentThread({
              managerUserId: threadRef.managerUserId,
              residentPhone: from,
              residentUserId,
              residentEmail: residentEmail || null,
              topic: action.threadTopic,
            }),
          );
        }
        await Promise.all(tasks);
      });

      return {
        ok: send.ok,
        intent: "unknown",
        replied: send.ok,
        error: send.ok ? undefined : send.error,
      };
    }
    }
  }

  const intent = classifyLeasingIntent(text);
  const origin = publicAppOrigin();
  const managers = scopedManagerId
    ? await resolveManagerTarget(scopedManagerId)
    : await resolveMappedManagers();
  const hintId = extractPropertyIdHint(text);
  let bundleId = extractBundleIdHint(text);
  const hinted =
    (await resolvePropertyHint(hintId, managers)) ??
    (await resolvePropertyByLabelHint(extractPropertyLabelHint(text), managers));
  const propertyId = hinted?.propertyId || managers[0]?.defaultPropertyId || null;
  const propertyLabel =
    hinted?.propertyLabel || managers[0]?.defaultPropertyLabel || null;
  if (!bundleId) {
    bundleId = await resolveBundleIdByLabel(propertyId, extractBundleLabelHint(text));
  }

  const landlordId =
    hinted?.managerUserId || managers[0]?.userId || scopedManagerId || null;

  // Persist prospect inbound so Communication → SMS shows both sides of the
  // Claw thread (outbound already logs via sendFromManagerWorkNumber).
  if (landlordId) {
    const toLine = workNumber || clawLeasingAgentPhoneE164();
    const inboundLogged = await persistClawInboundSms({
      managerUserId: landlordId,
      residentPhone: from,
      body: text,
      fromPhone: from,
      toPhone: toLine,
      messageId,
      counterpartyRole: "prospect",
    }).catch((e) => {
      console.error("claw leasing inbound log failed", e);
      return false;
    });
    if (!inboundLogged) {
      console.error("claw leasing inbound claim/consent failed; reply withheld", {
        managerUserId: landlordId,
      });
      releaseInboundMessageClaims(claimedMessageIds);
      return { ok: false, intent, replied: false, error: "Inbound receipt unavailable." };
    }
  }

  // Claude leasing agent on the manager's work number — grounds replies on live
  // listings, matches house/room, and mints apply links with phone/room prefills.
  // Keyword templates remain the fallback when the API key is missing or the
  // turn fails (keeps SMS responsive).
  if (landlordId) {
    try {
      const { runLeasingSmsAgentTurn, deliverLeasingSmsReply } = await import(
        "@/lib/agent/leasing-sms-agent.server"
      );
      const db = createSupabaseServiceRoleClient();
      const agent = await runLeasingSmsAgentTurn(db, {
        landlordId,
        prospectPhoneE164: from,
        inboundText: text,
        workNumber,
        inboundMessageSid: messageId,
        // Shared Claw line (no single scoped manager) fronts every manager, so
        // the agent must be able to look up ANY live listing on PropLane, not
        // just landlordId's. A per-manager Twilio number stays scoped.
        crossCatalog: !scopedManagerId,
      });
      if (agent?.reply) {
        const prepared = args.onPreparedReply
          ? await args.onPreparedReply({
              routeKind: "leasing_agent",
              replyBody: agent.reply,
              agentSessionId: agent.sessionId,
              inboundAgentMessageId: agent.inboundMessageId,
              assistantAgentMessageId: agent.assistantMessageId,
              turnTraceId: agent.traceId,
            })
          : true;
        if (!prepared) {
          releaseInboundMessageClaims(claimedMessageIds);
          return { ok: false, intent, replied: false, error: "Reply preparation failed." };
        }
        const send = await deliverLeasingSmsReply({
          landlordId,
          toPhone: from,
          text: agent.reply,
          workNumber,
          inboundMessageSid: messageId,
          traceId: agent.traceId,
        });
        if (send.ok || send.durablyAccepted) {
          const subjectLabel =
            intent === "tour" || intent === "tour_details"
              ? "Tour request"
              : intent === "apply" || intent === "bundle"
                ? "Application"
                : intent === "question"
                  ? "Question"
                  : "Leasing text";
          runAfterReply(async () => {
            const { resolvePropertyScopedManagerRecipientIds } = await import(
              "@/lib/co-manager-notification-recipients.server"
            );
            const recipientIds = await resolvePropertyScopedManagerRecipientIds(db, {
              ownerManagerUserId: landlordId,
              propertyId,
              channel: "inbox",
            });
            await Promise.all([
              forwardClawInboundToManagers({
                fromResident: from,
                text,
                intentLabel: "leasing conversation",
                propertyLabel,
                managerUserId: landlordId,
                workNumber,
                autoReply: agent.reply,
              }),
              ...recipientIds.map((managerUserId) =>
                upsertManagerInboxNotice(db, {
                  managerUserId,
                  idPrefix: "claw_lease",
                  threadType: "claw_leasing_sms",
                  from: from,
                  subject: `(${subjectLabel}${propertyLabel ? ` — ${propertyLabel}` : ""}) ${from}`,
                  preview: text.slice(0, 140) || "(empty)",
                  // Thread body is ONLY the prospect's words. The leasing
                  // assistant reply already went to their phone; the manager's
                  // AI draft card is generated separately for an optional
                  // follow-up — never paste the auto-reply into this notice.
                  body: text || "(empty message)",
                  unread: true,
                }),
              ),
            ]);
          });
          return {
            ok: true,
            intent,
            replied: true,
            outboxId: send.outboxId,
            durablyAccepted: send.durablyAccepted,
          };
        }
      }
    } catch (e) {
      console.error("leasing SMS agent path failed; falling back to templates", e);
    }
  }

  const reply = replyForIntent({
    intent,
    origin,
    propertyId,
    propertyLabel,
    bundleId,
    phone: from,
  });
  const prepared = args.onPreparedReply
    ? await args.onPreparedReply({ routeKind: "leasing_template", replyBody: reply })
    : true;
  if (!prepared) {
    releaseInboundMessageClaims(claimedMessageIds);
    return { ok: false, intent, replied: false, error: "Reply preparation failed." };
  }
  const send = await replySms({
    to: from,
    text: reply,
    managerUserId: landlordId,
    workNumber,
    counterpartyRole: "prospect",
    conversationKey: buildConversationKey({
      ownerManagerUserId: landlordId,
      role: "prospect",
      counterpartyPhone: from,
    }),
    dedupeKey: messageId ? `inbound_reply_${messageId}` : null,
  });
  if (!send.ok && !send.durablyAccepted) {
    return { ok: false, intent, replied: false, error: send.error || "Send failed." };
  }

  const intentLabel =
    intent === "tour" || intent === "tour_details"
      ? "tour request"
      : intent === "apply" || intent === "bundle"
        ? "application request"
        : intent === "question"
          ? "question"
          : "leasing message";
  const subjectLabel =
    intent === "tour" || intent === "tour_details"
      ? "Tour request"
      : intent === "apply" || intent === "bundle"
        ? "Application"
        : intent === "question"
          ? "Question"
          : "Text";

  runAfterReply(async () => {
    const db = createSupabaseServiceRoleClient();
    const { resolvePropertyScopedManagerRecipientIds } = await import(
      "@/lib/co-manager-notification-recipients.server"
    );
    // Scope strictly to the RESOLVED owner of this conversation (the matched
    // listing's manager, or the deterministic anchor when unmatched) — never
    // every mapped manager, or a shared line with several real managers would
    // leak each other's prospects into every manager's inbox.
    const ownerIds = landlordId ? [landlordId] : [];
    const recipientIdSets = await Promise.all(
      ownerIds.map((ownerManagerUserId) =>
        resolvePropertyScopedManagerRecipientIds(db, {
          ownerManagerUserId,
          propertyId,
          channel: "inbox",
        }),
      ),
    );
    const recipientIds = [...new Set(recipientIdSets.flat())];
    await Promise.all([
      forwardClawInboundToManagers({
        fromResident: from,
        text,
        intentLabel,
        propertyLabel,
        managerUserId: landlordId,
        workNumber,
        autoReply: reply,
      }),
      ...recipientIds.map((managerUserId) =>
        upsertManagerInboxNotice(db, {
          managerUserId,
          idPrefix: "claw_lease",
          threadType: "claw_leasing_sms",
          from: from,
          subject: `(${subjectLabel}${propertyLabel ? ` — ${propertyLabel}` : ""}) ${from}`,
          preview: text.slice(0, 140) || "(empty)",
          body: text || "(empty message)",
          unread: true,
        }),
      ),
    ]);
  });

  return {
    ok: true,
    intent,
    replied: true,
    outboxId: send.outboxId,
    durablyAccepted: send.durablyAccepted,
  };
}
