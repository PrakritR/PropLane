/**
 * Server-side tour notification delivery (Resend email + Axis inbox records).
 */

import { issueTourSignupCapability } from "@/lib/auth/tour-signup-capability.server";
import { noticeChannelFor, withResidentPortalLink } from "@/lib/notice-channel";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { formatPacificDateTime } from "@/lib/pacific-time";
import { REQUESTED_TOUR_KIND } from "@/lib/tour-request-time";
import { appendResidentPropertyManagerInboxMessage, appendManagerPropertyLeadInboxMessage } from "@/lib/property-manager-inbox-thread.server";
import { sendManagerNotificationSms } from "@/lib/manager-notification-routing.server";
import { sendResidentOutboundSms, type ResidentOutboundSmsResult } from "@/lib/resident-outbound-sms.server";
import { resolveTourSmsEligibility } from "@/lib/sms/tour-sms-eligibility.server";
import { fetchManagerSmsConversations } from "@/lib/manager-sms-messages.server";
import { resolveExistingApplicantConversation } from "@/lib/application-lifecycle-sms.server";
import { traceSystemNotification } from "@/lib/observability/langfuse";
import { buildReplyAddress } from "@/lib/inbound-email/reply-address.server";
import { shouldSkipOutboundEmail } from "@/lib/portal-sandbox-accounts";
import { managerOutboundFromHeader } from "@/lib/manager-outbound-identity.server";
import {
  postTeamNoticeLineForEvent,
  resolveManagerRecipientProfiles,
  resolvePropertyLeadRecipientIds,
} from "@/lib/co-manager-notification-recipients.server";
import { buildTeamNoticeLine } from "@/lib/team-notice-line";
import { postResendEmail } from "@/lib/resend-delivery.server";
import { deliverPortalMessageThreadSide } from "@/lib/portal-inbox-delivery";
import {
  TOUR_CANCELED_TENANT_SUBJECT,
  TOUR_CONFIRMED_TENANT_SUBJECT,
  TOUR_REQUEST_MANAGER_SUBJECT,
  TOUR_REQUEST_REMOVED_TENANT_SUBJECT,
  TOUR_REQUEST_TENANT_SUBJECT,
  TOUR_RESCHEDULED_TENANT_SUBJECT,
  buildTourCanceledTenantBody,
  buildTourConfirmedTenantBody,
  buildTourConfirmedTenantHtml,
  buildTourNotificationContext,
  buildTourRequestManagerBody,
  buildTourRequestedTimeHeadline,
  buildTourRequestRemovedTenantBody,
  buildTourRescheduleConfirmRequestBody,
  buildTourRescheduledTenantBody,
  formatTourTimeRange,
  buildTourRequestTenantBody,
  tourRequestNotificationContexts,
} from "@/lib/tour-notifications";

const RESIDENT_INBOX_SCOPE = "axis_portal_inbox_resident_v1";

type Db = ReturnType<typeof import("@/lib/supabase/service").createSupabaseServiceRoleClient>;

function textField(row: Record<string, unknown> | null | undefined, key: string): string {
  const value = row?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

async function resolveTourManagerIdentity(db: Db, managerUserId: string): Promise<{ email: string; name: string } | null> {
  const id = managerUserId.trim();
  if (!id) return null;
  const { data, error } = await db.from("profiles").select("id, email, full_name").eq("id", id).maybeSingle();
  const email = String(data?.email ?? "").trim().toLowerCase();
  return error || !email.includes("@") ? null : { email, name: String(data?.full_name ?? "").trim() || email };
}

export async function resolvePropertyAddressForTour(
  db: Db,
  propertyId: string | null | undefined,
): Promise<string> {
  const id = textField({ id: propertyId ?? "" }, "id");
  if (!id) return "";
  const { data } = await db
    .from("manager_property_records")
    .select("id, property_data, row_data")
    .eq("id", id)
    .maybeSingle();
  if (data) {
    const pd = asObject(data.property_data);
    const rd = asObject(data.row_data);
    const address =
      textField(pd, "address") || textField(rd, "address") || textField(asObject(rd?.submission), "address");
    if (address) return address;
  }
  // Legacy rows can carry the id only inside their JSON blobs — fall back to a
  // filtered JSON-field match instead of a full-table scan.
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) return "";
  const { data: byJson } = await db
    .from("manager_property_records")
    .select("id, property_data, row_data")
    .or(`property_data->>id.eq.${id},row_data->>id.eq.${id}`)
    .limit(5);
  for (const row of byJson ?? []) {
    const pd = asObject(row.property_data);
    const rd = asObject(row.row_data);
    const address =
      textField(pd, "address") || textField(rd, "address") || textField(asObject(rd?.submission), "address");
    if (address) return address;
  }
  return "";
}

async function deliverEmail(
  to: string[],
  subject: string,
  text: string,
  html?: string,
  replyTo?: string | null,
  identity?: { db: Db; managerUserId: string | null | undefined },
): Promise<{ sent: boolean; skipped: boolean; error?: string }> {
  // `shouldSkipOutboundEmail` is the ONE rule for sandbox addresses, and it covers BOTH
  // `@axis.local` and `@test.proplane.local`. This hand-rolled check only knew the first, so
  // tour mail to the canonical test accounts — the ones AGENTS.md says the demo portfolio and
  // e2e runs use — was posted to Resend for a domain that does not exist. Every tour confirmation
  // during testing became a real send that could only bounce, which is both a false "sent" signal
  // and a slow way to damage sender reputation.
  const recipients = to
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.includes("@") && !shouldSkipOutboundEmail(email));
  if (recipients.length === 0) return { sent: false, skipped: true };
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return { sent: false, skipped: false, error: "Email delivery not configured (RESEND_API_KEY missing)." };
  const actorUserId = identity?.managerUserId?.trim() ?? "";
  if (!identity || !actorUserId) {
    return { sent: false, skipped: false, error: "Manager identity is required for email delivery." };
  }
  const from = await managerOutboundFromHeader(identity.db, actorUserId);
  const res = await postResendEmail({
    apiKey,
    actorUserId,
    payload: {
      from,
      to: recipients,
      subject,
      text,
      ...(html ? { html } : {}),
      ...(replyTo ? { reply_to: replyTo } : {}),
    },
    effectSummary: `Tour notification email to ${recipients.length} recipient${recipients.length === 1 ? "" : "s"} was captured for SMS test mode.`,
    metadata: { recipients: recipients.length },
  });
  const payload = (await res.json().catch(() => ({}))) as { message?: string };
  if (!res.ok) return { sent: false, skipped: false, error: payload.message ?? "Email send failed." };
  return { sent: true, skipped: false };
}

export type TourNotificationChannels = {
  viaEmail?: boolean;
  viaSms?: boolean;
};

export type TourNotificationResult = {
  ok: boolean;
  skipped?: boolean;
  error?: string;
  email: { requested: boolean; sent: boolean; skipped: boolean; error?: string };
  sms: {
    requested: boolean;
    sent: boolean;
    accepted?: boolean;
    skipped: boolean;
    error?: string;
    channel?: "claw" | "twilio" | "in_app_test";
    sid?: string;
    outboxStatus?: string;
  };
  inbox: { sent: boolean; error?: string };
};

function notificationResult(
  email: TourNotificationResult["email"],
  sms: TourNotificationResult["sms"],
  inbox: TourNotificationResult["inbox"] = { sent: false },
): TourNotificationResult {
  const smsMissing = sms.requested && !sms.sent && !sms.accepted;
  // Only a channel that was actually ATTEMPTED can fail. A notice whose every REQUESTED
  // channel came back deliberately skipped (sandbox address, no mail provider) is `skipped`,
  // not a failure — the same reading `tourGuestNotificationFailed` applies on the client — so
  // a tour confirmed exactly as configured raises no delivery-failure toast.
  //
  // A notice asked for with NO channel at all is still a failure: the guest will never hear
  // about the change, and nothing was skipped on their behalf to make that acceptable.
  const nothingRequested = !email.requested && !sms.requested;
  const attempted = (email.requested && !email.skipped) || (sms.requested && !sms.skipped);
  const nothingDelivered = (nothingRequested || attempted) && !email.sent && !sms.sent && !sms.accepted && !inbox.sent;
  const failed = Boolean(email.error || sms.error || smsMissing || inbox.error || nothingDelivered);
  return {
    ok: !failed,
    skipped: email.skipped && sms.skipped,
    ...(sms.error || smsMissing || email.error || inbox.error || nothingDelivered
      ? { error: sms.error || (smsMissing ? "SMS was not sent." : inbox.error || email.error || "No notification was delivered.") }
      : {}),
    email,
    sms,
    inbox,
  };
}

function summarizeTourLifecycleNotification(result: TourNotificationResult): Record<string, unknown> {
  const reason = result.ok
    ? result.skipped
      ? "all_requested_channels_skipped"
      : "completed_with_channel_results"
    : result.sms.requested && !result.sms.sent && !result.sms.accepted
      ? "sms_not_delivered"
      : result.email.error
        ? "email_not_delivered"
        : result.inbox.error
          ? "inbox_not_saved"
          : "notification_failed";
  return {
    ok: result.ok,
    reason,
    emailRequested: result.email.requested,
    emailSent: result.email.sent,
    emailSkipped: result.email.skipped,
    smsRequested: result.sms.requested,
    smsSent: result.sms.sent,
    smsAccepted: result.sms.accepted ?? false,
    smsSkipped: result.sms.skipped,
    smsChannel: result.sms.channel ?? null,
    smsSid: result.sms.sid ?? null,
    smsOutboxStatus: result.sms.outboxStatus ?? null,
    inboxSent: result.inbox.sent,
  };
}

async function upsertInboxThread(
  db: Db,
  input: {
    scope: string;
    ownerUserId: string | null;
    participantEmail: string;
    residentUserId?: string;
    folder: "inbox" | "sent";
    fromName: string;
    fromEmail: string;
    toLine: string;
    subject: string;
    body: string;
    preview?: string;
    rootOutbound?: boolean;
    messages?: Array<{
      id: string;
      from: string;
      body: string;
      at: string;
      outbound?: boolean;
    }>;
    threadType?: string;
    /** The manager / house the notice is from, when the caller knows them. */
    conversation?: { managerUserId?: string | null; propertyId?: string | null };
  },
): Promise<boolean> {
  const when = formatPacificDateTime(new Date());
  const preview = (input.preview ?? input.body).slice(0, 100).replace(/\n/g, " ");
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 6);
  const threadId = `tour_${input.folder}_${ts}_${rand}`;
  // One conversation per person per workspace: a tour, welcome or lead notice
  // joins the person's existing conversation instead of minting a row per event.
  try {
    await deliverPortalMessageThreadSide(db, {
      scope: input.scope,
      folder: input.folder,
      ownerUserId: input.ownerUserId,
      participantEmail: input.participantEmail.trim().toLowerCase(),
      otherPartyEmail: (input.folder === "sent" ? input.toLine : input.fromEmail).trim().toLowerCase(),
      fallbackId: threadId,
      fromName: input.fromName,
      subject: input.subject,
      body: input.body,
      preview,
      when,
      unread: input.folder === "inbox",
      outbound: input.folder === "sent",
      threadType: input.threadType ?? "tour_notification",
      ...(input.rootOutbound ? { rootOutbound: true } : {}),
      ...(input.messages?.length ? { followUps: input.messages } : {}),
      ...(input.conversation ? { conversation: input.conversation } : {}),
    });
    return true;
  } catch {
    return false;
  }
}

/** Resident inbox row only when the caller has established its exact subject. */
export async function recordResidentProspectInboxMessage(
  db: Db,
  input: {
    participantEmail: string;
    residentUserId?: string;
    subject: string;
    body: string;
    fromName?: string;
    fromEmail?: string;
    threadType?: string;
    /** When set, stores the resident's outbound turn as the root message and `body` as the follow-up ack. */
    residentMessage?: string;
    residentName?: string;
    /** Counterparty email stored on the thread (e.g. the manager's inbox address). */
    counterpartyEmail?: string;
    managerUserId?: string;
    propertyId?: string;
    propertyTitle?: string;
  },
): Promise<void> {
  const ownerUserId = input.residentUserId?.trim() ?? "";
  if (!ownerUserId) return;
  const managerUserId = input.managerUserId?.trim() ?? "";
  const propertyId = input.propertyId?.trim() ?? "";
  const propertyTitle = input.propertyTitle?.trim() ?? "";
  if (managerUserId && propertyId) {
    await appendResidentPropertyManagerInboxMessage(db, {
      participantEmail: input.participantEmail,
      residentUserId: ownerUserId,
      managerUserId,
      propertyId,
      propertyTitle: propertyTitle || propertyId,
      subject: input.subject,
      body: input.body,
      residentMessage: input.residentMessage,
      residentName: input.residentName,
      counterpartyEmail: input.counterpartyEmail ?? input.fromEmail,
      fromName: input.fromName,
    });
    return;
  }

  const guestEmail = input.participantEmail.trim().toLowerCase();
  if (!guestEmail.includes("@")) return;
  const residentMessage = input.residentMessage?.trim() ?? "";
  const counterpartyEmail = input.counterpartyEmail?.trim().toLowerCase() || input.fromEmail || "tours@axis.local";

  if (residentMessage) {
    const when = formatPacificDateTime(new Date());
    const ackFrom = input.fromName ?? "PropLane";
    await upsertInboxThread(db, {
      scope: RESIDENT_INBOX_SCOPE,
      ownerUserId,
      participantEmail: guestEmail,
      folder: "inbox",
      fromName: input.residentName?.trim() || "You",
      fromEmail: counterpartyEmail,
      toLine: guestEmail,
      subject: input.subject,
      body: residentMessage,
      preview: input.body,
      rootOutbound: true,
      threadType: input.threadType ?? "portal_message",
      conversation: { managerUserId: input.managerUserId, propertyId: input.propertyId },
      messages: [
        {
          id: `ack-${Date.now().toString(36)}`,
          from: ackFrom,
          body: input.body,
          at: when,
          outbound: false,
        },
      ],
    });
    return;
  }

  await upsertInboxThread(db, {
    scope: RESIDENT_INBOX_SCOPE,
    ownerUserId,
    participantEmail: guestEmail,
    folder: "inbox",
    fromName: input.fromName ?? "PropLane",
    fromEmail: input.fromEmail ?? "tours@axis.local",
    toLine: guestEmail,
    subject: input.subject,
    body: input.body,
    threadType: input.threadType,
    conversation: { managerUserId: input.managerUserId, propertyId: input.propertyId },
  });
}

/**
 * The guest's in-app inbox copy is a courtesy, never a gate. A guest whose
 * portal is on deletion hold has frozen inbox rows (the account-recovery
 * write guard refuses the insert), and a guest with no account has no inbox
 * at all — the email and SMS are the notification and must still go out.
 */
async function recordGuestInboxCopy(
  db: Db,
  inquiryId: string | null,
  input: Parameters<typeof recordResidentProspectInboxMessage>[1],
): Promise<{ sent: boolean; error?: string }> {
  try {
    const owner = await linkedTourNoticeOwner(db, inquiryId, input.propertyId ?? null);
    if (!owner) return { sent: false };
    await recordResidentProspectInboxMessage(db, { ...input, residentUserId: owner });
    return { sent: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not record the guest inbox copy.";
    console.warn("[tour-notification] guest inbox copy skipped", { inquiryId, error: message });
    return { sent: false, error: message };
  }
}

/**
 * Exact inquiry binding, never a profile or email match, authorizes an inbox copy.
 *
 * The link stores the manager the inquiry was FILED under, while a notice is sent by the
 * CURRENT host — `confirmTourInquiry` hands a tour to a peer. So the binding is the inquiry id
 * plus the inquiry's CURRENT property (historical caller-chosen ids are not unique across
 * properties), never the filing manager: exactly one link row may claim that pair, and its
 * `resident_user_id` is the only subject allowed to receive the copy. No property, no copy.
 */
async function linkedTourNoticeOwner(db: Db, inquiryId: string | null, propertyId: string | null): Promise<string | null> {
  const property = propertyId?.trim();
  if (!inquiryId || !property) return null;
  try {
    const { data, error } = await db
      .from("resident_tour_links")
      .select("resident_user_id")
      .eq("inquiry_id", inquiryId)
      .eq("property_id", property)
      .limit(2);
    if (error || !data || data.length !== 1) return null;
    const subject = typeof data[0]?.resident_user_id === "string" ? data[0].resident_user_id.trim() : "";
    return subject || null;
  } catch {
    return null;
  }
}

export type TourInquiryPayload = {
  name?: unknown;
  email?: unknown;
  phone?: unknown;
  /** Explicit A2P/CTIA SMS opt-in captured on the tours-contact form. */
  smsConsent?: unknown;
  /** Server-owned channel provenance. Public inquiry input cannot set this field. */
  smsOrigin?: unknown;
  notes?: unknown;
  propertyId?: unknown;
  propertyTitle?: unknown;
  roomLabel?: unknown;
  managerUserId?: unknown;
  adminLabel?: unknown;
  proposedStart?: unknown;
  proposedEnd?: unknown;
  /** `"requested_time"` when the guest picked the time themselves (server-stamped). */
  requestKind?: unknown;
};

export async function notifyManagerTourRequest(
  db: Db,
  /** Unused: origins come from `app-url.ts`, never the incoming request (see below). */
  req: Request | null,
  inquiry: TourInquiryPayload,
  window?: { start: string; end: string },
): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  const managerUserId = textField(inquiry as Record<string, unknown>, "managerUserId");
  if (!managerUserId) return { ok: false, error: "Manager not found for tour request." };

  const { data: managerProfile } = await db.from("profiles").select("id, email, full_name").eq("id", managerUserId).maybeSingle();
  const managerEmail = String(managerProfile?.email ?? "").trim().toLowerCase();
  if (!managerEmail) return { ok: false, error: "Manager email not found." };

  const tourStartIso = window?.start || textField(inquiry as Record<string, unknown>, "proposedStart");
  const tourEndIso = window?.end || textField(inquiry as Record<string, unknown>, "proposedEnd");
  const propertyId = textField(inquiry as Record<string, unknown>, "propertyId");
  const propertyAddress = await resolvePropertyAddressForTour(db, propertyId);
  // Notification links must always use PropLane's canonical host. Building
  // them from the incoming request leaked the legacy Axis domain whenever a
  // prospect booked through that still-supported production alias.
  const origin = resolveEmailLinkBaseUrl();
  const ctx = buildTourNotificationContext({
    origin,
    guestName: textField(inquiry as Record<string, unknown>, "name") || "Guest",
    guestEmail: textField(inquiry as Record<string, unknown>, "email"),
    guestPhone: textField(inquiry as Record<string, unknown>, "phone") || null,
    propertyId,
    propertyTitle: textField(inquiry as Record<string, unknown>, "propertyTitle") || "Property",
    propertyAddress,
    roomLabel: textField(inquiry as Record<string, unknown>, "roomLabel") || null,
    tourFormat: textField(inquiry as Record<string, unknown>, "tourFormat") || null,
    tourStartIso,
    tourEndIso,
    notes: textField(inquiry as Record<string, unknown>, "notes") || null,
    requestedTime: textField(inquiry as Record<string, unknown>, "requestKind") === REQUESTED_TOUR_KIND,
    managerLabel: textField(inquiry as Record<string, unknown>, "adminLabel") || managerProfile?.full_name || null,
    tourInquiryId: textField(inquiry as Record<string, unknown>, "id") || null,
  });

  const subject = TOUR_REQUEST_MANAGER_SUBJECT;
  const text = buildTourRequestManagerBody(ctx);
  const guestEmail = textField(inquiry as Record<string, unknown>, "email").trim().toLowerCase();
  if (!guestEmail.includes("@")) return { ok: false, error: "Guest email is required." };

  const recipientIds = await resolvePropertyLeadRecipientIds(db, {
    ownerManagerUserId: managerUserId,
    propertyId,
  });
  const recipients = await resolveManagerRecipientProfiles(db, recipientIds);
  if (recipients.length === 0) return { ok: false, error: "Manager email not found." };

  // ONE host-team thread per prospect (A4): the tour request is a single turn in the workspace OWNER's conversation with the
  // person, stamped with the house (`houseId` on the turn and `propertyId` on the thread). A co-manager holding that house
  // with Communication sees the same conversation through the visibility rule (`conversation-visibility.server.ts`), and
  // answers in it as themselves; a co-manager holding another house, or none, does not. They get the email / text / Team
  // line below instead of a copy of their own.
  let smsConversationKey: string | undefined;
  const guestPhone = textField(inquiry as Record<string, unknown>, "phone");
  if (guestPhone) try {
    const conversations = await fetchManagerSmsConversations(db, managerUserId, { scopeManagerIdsOverride: [managerUserId], provisionWorkNumber: false, visibility: "none" });
    const existing = resolveExistingApplicantConversation(conversations.residents, { managerUserId, applicantPhone: guestPhone, workNumber: conversations.workNumber });
    if (existing.kind === "matched") smsConversationKey = existing.conversation.conversationKey;
  } catch { smsConversationKey = undefined; }
  await appendManagerPropertyLeadInboxMessage(db, managerUserId, {
    propertyId,
    propertyTitle: ctx.propertyTitle || "Property",
    prospectName: ctx.guestName || "Guest",
    prospectEmail: guestEmail,
    topic: "Tour request",
    subject,
    body: text,
    counterpartyRole: "prospect",
    outbound: false,
    messageId: `tour:${textField(inquiry as Record<string, unknown>, "id") || propertyId}:request:${tourStartIso}:${tourEndIso}`,
    ...(smsConversationKey ? { smsConversationKey } : {}),
  });

  // Teammates are told where the one thread is: the email carries the Communication link, and the workspace Team chat gets one
  // plain line (idempotent per request). Neither is a copy of the lead.
  const emailText = `${text}\n\nReply to ${ctx.guestName || "the guest"} in Communication: ${origin.replace(/\/$/, "")}/portal/communication/active`;
  const coManagerIds = recipients.map((recipient) => recipient.userId).filter((id) => id !== managerUserId);
  if (coManagerIds.length > 0) {
    try {
      await postTeamNoticeLineForEvent(db, {
        ownerManagerUserId: managerUserId,
        propertyId,
        module: "calendar",
        teamNotice: {
          messageId: `tour:${textField(inquiry as Record<string, unknown>, "id") || propertyId}:request:${tourStartIso}:${tourEndIso}:team`,
          text: buildTeamNoticeLine({
            domain: "tour",
            event: "requested",
            subject: ctx.guestName || "Guest",
            place: [ctx.propertyTitle, ctx.roomLabel].filter(Boolean).join(" "),
          }),
        },
        excludeUserIds: [managerUserId],
      });
    } catch {
      /* non-critical: the email and text above already reached the teammates */
    }
  }

  const email = await deliverEmail(
    recipients.map((recipient) => recipient.email),
    subject,
    emailText,
    undefined,
    undefined,
    { db, managerUserId },
  );

  // Also text any recipient with a forward-enabled phone on file (e.g. the
  // admin's own DB-backed number) — a tour request shouldn't wait on email.
  const smsText = `PropLane: new tour request${ctx.propertyTitle ? ` — ${ctx.propertyTitle}` : ""}${
    ctx.tourStartIso ? ` (${formatTourTimeRange(ctx.tourStartIso, ctx.tourEndIso)})` : ""
  }. ${ctx.requestedTime ? `${buildTourRequestedTimeHeadline(ctx)}.` : `${ctx.guestName} requested a tour.`} Check your PropLane inbox for details.`;
  await Promise.all(
    recipients.map((recipient) =>
      sendManagerNotificationSms(db, {
        managerUserId: recipient.userId,
        category: "leasing",
        subject: "New tour request",
        text: smsText,
        purpose: "tour_request_manager_notification",
      }).catch(() => undefined),
    ),
  );

  if (email.error) return { ok: true, skipped: true, error: email.error };
  return { ok: true, skipped: email.skipped };
}


/** Text the tour guest via the resident SMS channel (Claw shared line). */
async function textTourGuest(args: {
  db: Db;
  managerUserId: string;
  guestEmail: string;
  guestPhone: string | null;
  smsConsent: boolean;
  text: string;
  purpose: string;
  inquiryId: string | null;
  deliveryKey?: string | null;
  /** False only for newly persisted non-SMS origins. Legacy rows remain eligible for proven inbound evidence. */
  allowConversationEvidence?: boolean;
  eligibility?: Awaited<ReturnType<typeof resolveTourSmsEligibility>>;
  /** The tour row's recorded channel (`notice-channel.ts`): a tour made in the portal / on the web is never texted. */
  inquiry?: unknown;
}): Promise<TourNotificationResult["sms"]> {
  if (args.inquiry !== undefined && noticeChannelFor(args.inquiry) === "portal") {
    return { requested: false, sent: false, skipped: true };
  }
  const eligibility = args.eligibility ?? await resolveTourSmsEligibility(args.db, {
    managerUserId: args.managerUserId,
    guestPhone: args.guestPhone,
    explicitOptIn: args.smsConsent,
    purpose: args.purpose,
    allowConversationEvidence: args.allowConversationEvidence,
    inquiryId: args.inquiryId,
  });
  if (!eligibility.eligible) return { requested: true, sent: false, skipped: true, error: eligibility.reason };
  const result: ResidentOutboundSmsResult = await sendResidentOutboundSms({
    to: eligibility.phoneE164,
    text: args.text,
    openThread: {
      managerUserId: args.managerUserId,
      residentEmail: args.guestEmail,
      topic: "leasing",
      counterpartyRole: "prospect",
      conversationKey: eligibility.conversationKey,
    },
    purpose: args.purpose,
    sendClass: "transactional",
    dedupeKey: `${args.purpose}_${args.deliveryKey ?? args.inquiryId ?? eligibility.conversationKey}`,
    mirrorToManager: false,
  }).catch((error: unknown) => ({
    sent: false,
    error: error instanceof Error ? error.message : "SMS delivery failed.",
  }));
  return {
    requested: true,
    sent: result.sent,
    ...(result.accepted ? { accepted: true } : {}),
    skipped: false,
    ...(result.channel ? { channel: result.channel } : {}),
    ...(result.sid ? { sid: result.sid } : {}),
    ...(result.outboxStatus ? { outboxStatus: result.outboxStatus } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
}

function generatedTourChangeBodyMatch(
  ctx: ReturnType<typeof buildTourNotificationContext>,
  input: {
    pendingProposal: boolean;
    previous: { startIso: string; endIso: string };
    reason?: string | null;
  },
  suppliedBody: string,
): { generated: boolean; replyPathClaimsAreAvailable: boolean } {
  const options = [
    { smsSelected: false, smsAvailable: false, emailSelected: false, emailReplyAvailable: false },
    { smsSelected: false, smsAvailable: Boolean(ctx.guestPhone), emailSelected: true, emailReplyAvailable: false },
    { smsSelected: true, smsAvailable: Boolean(ctx.guestPhone), emailSelected: false, emailReplyAvailable: false },
    { smsSelected: true, smsAvailable: Boolean(ctx.guestPhone), emailSelected: true, emailReplyAvailable: false },
    { smsSelected: false, smsAvailable: false, emailSelected: true, emailReplyAvailable: true },
    { smsSelected: true, smsAvailable: true, emailSelected: true, emailReplyAvailable: true },
  ];
  for (const replyOptions of options) {
    const candidate = { ...ctx, replyOptions };
    const body = (input.pendingProposal
      ? buildTourRescheduleConfirmRequestBody(candidate, input.previous)
      : buildTourRescheduledTenantBody(candidate, input.previous, input.reason)).trim();
    if (body !== suppliedBody) continue;
    const claimsSms = replyOptions.smsSelected && replyOptions.smsAvailable;
    const claimsEmail = replyOptions.emailSelected && replyOptions.emailReplyAvailable;
    return {
      generated: true,
      replyPathClaimsAreAvailable:
        (!claimsSms || (ctx.replyOptions?.smsSelected === true && ctx.replyOptions.smsAvailable === true)) &&
        (!claimsEmail || (ctx.replyOptions?.emailSelected === true && ctx.replyOptions.emailReplyAvailable === true)),
    };
  }
  return { generated: false, replyPathClaimsAreAvailable: true };
}

/** Read the explicit SMS opt-in flag persisted alongside a tour inquiry. */
function inquirySmsConsent(inquiry: TourInquiryPayload): boolean {
  return (inquiry as Record<string, unknown>).smsConsent === true;
}

function inquiryAllowsConversationSmsEvidence(inquiry: TourInquiryPayload): boolean {
  const origin = (inquiry as Record<string, unknown>).smsOrigin;
  return origin === undefined || origin === "leasing_sms";
}

export async function notifyTenantTourRequestReceived(
  db: Db,
  /** Unused: origins come from `app-url.ts`, never the incoming request (see below). */
  req: Request | null,
  inquiry: TourInquiryPayload,
  window?: { start: string; end: string },
): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  const guestEmail = textField(inquiry as Record<string, unknown>, "email");
  if (!guestEmail || !guestEmail.includes("@")) {
    return { ok: false, error: "Guest email is required." };
  }

  const tourStartIso = window?.start || textField(inquiry as Record<string, unknown>, "proposedStart");
  const tourEndIso = window?.end || textField(inquiry as Record<string, unknown>, "proposedEnd");
  const propertyId = textField(inquiry as Record<string, unknown>, "propertyId");
  const propertyAddress = await resolvePropertyAddressForTour(db, propertyId);
  const origin = resolveEmailLinkBaseUrl();
  const ctx = buildTourNotificationContext({
    origin,
    guestName: textField(inquiry as Record<string, unknown>, "name") || "Guest",
    guestEmail,
    guestPhone: textField(inquiry as Record<string, unknown>, "phone") || null,
    propertyId,
    propertyTitle: textField(inquiry as Record<string, unknown>, "propertyTitle") || "Property",
    propertyAddress,
    roomLabel: textField(inquiry as Record<string, unknown>, "roomLabel") || null,
    tourFormat: textField(inquiry as Record<string, unknown>, "tourFormat") || null,
    tourStartIso,
    tourEndIso,
    notes: textField(inquiry as Record<string, unknown>, "notes") || null,
    managerLabel: textField(inquiry as Record<string, unknown>, "adminLabel") || null,
    tourInquiryId: textField(inquiry as Record<string, unknown>, "id") || null,
  });

  // This capability is mailed only to the original contact, not copied to
  // portal inboxes, SMS history, analytics, or manager-facing notifications.
  const capability = await issueTourSignupCapability(db, {
    inquiryId: textField(inquiry as Record<string, unknown>, "id"), email: guestEmail,
    managerUserId: textField(inquiry as Record<string, unknown>, "managerUserId"), propertyId,
    tourGroupId: textField(inquiry as Record<string, unknown>, "tourGroupId"),
  }).catch(() => null);
  const { email: emailCtx, clean: cleanCtx } = tourRequestNotificationContexts(ctx, capability);
  const subject = TOUR_REQUEST_TENANT_SUBJECT;
  const portalChannel = noticeChannelFor(inquiry) === "portal";
  const text = portalChannel ? withResidentPortalLink(buildTourRequestTenantBody(cleanCtx), "tour") : buildTourRequestTenantBody(cleanCtx);
  const emailText = portalChannel ? withResidentPortalLink(buildTourRequestTenantBody(emailCtx), "tour") : buildTourRequestTenantBody(emailCtx);
  const email = await deliverEmail([guestEmail], subject, emailText, undefined, undefined, {
    db,
    managerUserId: textField(inquiry as Record<string, unknown>, "managerUserId"),
  });

  await recordGuestInboxCopy(db, textField(inquiry as Record<string, unknown>, "id") || null, {
    participantEmail: guestEmail,
    subject,
    body: text,
    fromName: "PropLane Tours",
    managerUserId: textField(inquiry as Record<string, unknown>, "managerUserId"),
    propertyId,
    propertyTitle: ctx.propertyTitle,
  });

  const guestPhone = textField(inquiry as Record<string, unknown>, "phone") || null;
  const listingLink = propertyId ? `${origin}/rent/listings/${propertyId}` : origin;
  const accountPrompt = "";
  await textTourGuest({
    db,
    managerUserId: textField(inquiry as Record<string, unknown>, "managerUserId"),
    guestEmail,
    guestPhone,
    smsConsent: inquirySmsConsent(inquiry),
    purpose: "tour_request_received",
    inquiry,
    inquiryId: textField(inquiry as Record<string, unknown>, "id") || null,
    allowConversationEvidence: inquiryAllowsConversationSmsEvidence(inquiry),
    text: `PropLane: we received your tour request for ${ctx.propertyTitle}${
      ctx.tourStartIso ? ` (${formatTourTimeRange(ctx.tourStartIso, ctx.tourEndIso)})` : ""
    }. We'll text you here once it's confirmed.${accountPrompt} Details: ${listingLink}. Reply STOP to opt out, HELP for help.`,
  });

  if (email.error) return { ok: true, skipped: true, error: email.error };
  return { ok: true, skipped: email.skipped };
}

/** Tell the guest a pending tour request was removed before it was confirmed. */
export async function notifyTenantTourRequestRemoved(
  db: Db,
  /** Unused: origins come from `app-url.ts`, never the incoming request (see below). */
  req: Request | null,
  inquiry: TourInquiryPayload,
  window?: { start: string; end: string },
  opts?: { subject?: string; body?: string },
): Promise<{ ok: boolean; skipped?: boolean; error?: string; inbox?: { sent: boolean; error?: string } }> {
  const row = inquiry as Record<string, unknown>;
  const guestEmail = textField(row, "email");
  if (!guestEmail || !guestEmail.includes("@")) {
    return { ok: false, error: "Guest email is required to notify the guest." };
  }

  const tourStartIso = window?.start || textField(row, "proposedStart");
  const tourEndIso = window?.end || textField(row, "proposedEnd");
  const propertyId = textField(row, "propertyId");
  const propertyAddress = await resolvePropertyAddressForTour(db, propertyId);
  const origin = resolveEmailLinkBaseUrl();
  const ctx = buildTourNotificationContext({
    origin,
    guestName: textField(row, "name") || "Guest",
    guestEmail,
    guestPhone: textField(row, "phone") || null,
    propertyId,
    propertyTitle: textField(row, "propertyTitle") || "Property",
    propertyAddress,
    roomLabel: textField(row, "roomLabel") || null,
    tourFormat: textField(row, "tourFormat") || null,
    tourStartIso,
    tourEndIso,
    notes: textField(row, "notes") || null,
    managerLabel: textField(row, "adminLabel") || null,
    tourInquiryId: textField(row, "id") || null,
  });

  const subject = opts?.subject?.trim() || TOUR_REQUEST_REMOVED_TENANT_SUBJECT;
  const removedText = opts?.body?.trim() || buildTourRequestRemovedTenantBody(ctx);
  const text = noticeChannelFor(inquiry) === "portal" ? withResidentPortalLink(removedText, "tour") : removedText;
  const managerUserId = textField(row, "managerUserId");

  const inbox = await recordGuestInboxCopy(db, textField(row, "id") || null, {
    participantEmail: guestEmail,
    subject,
    body: text,
    fromName: "PropLane Tours",
    managerUserId: managerUserId || undefined,
    propertyId: propertyId || undefined,
    propertyTitle: ctx.propertyTitle,
  });

  const email = await deliverEmail([guestEmail], subject, text, undefined, undefined, {
    db,
    managerUserId,
  });

  const listingLink = propertyId ? `${origin}/rent/listings/${propertyId}` : origin;
  await textTourGuest({
    db,
    managerUserId,
    guestEmail,
    guestPhone: textField(row, "phone") || null,
    smsConsent: inquirySmsConsent(inquiry),
    purpose: "tour_request_removed",
    inquiry,
    inquiryId: textField(row, "id") || null,
    allowConversationEvidence: inquiryAllowsConversationSmsEvidence(inquiry),
    text: `PropLane: your tour request for ${ctx.propertyTitle}${
      tourStartIso && tourEndIso ? ` (${formatTourTimeRange(tourStartIso, tourEndIso)})` : ""
    } was removed by the property team. Request another time: ${listingLink}. Reply STOP to opt out, HELP for help.`,
  });

  if (email.error) return { ok: false, skipped: false, error: email.error, inbox };
  return { ok: true, skipped: email.skipped, inbox };
}

/**
 * Tell the guest a confirmed tour changed — cancelled, or moved.
 *
 * Shares `notifyTenantTourConfirmed`'s delivery shape on purpose: the same
 * inbox thread, the same email, the same consent-gated SMS. A guest who was
 * told "confirmed" through those three channels has to be told the change
 * through them too, or the cancellation only exists inside the portal.
 */
async function notifyTenantTourChanged(
  db: Db,
  /** Unused: origins come from `app-url.ts`, never the incoming request (see below). */
  req: Request | null,
  inquiry: TourInquiryPayload,
  input: {
    kind: "canceled" | "rescheduled";
    window: { start: string; end: string; managerUserId?: string; adminLabel?: string };
    previousWindow?: { start: string; end: string };
    reason?: string | null;
    instructions?: string | null;
    /** Persisted by the real tour mutation; stable across notification retries. */
    rescheduleGeneration?: string;
    proposalRecordId?: string;
    subject?: string;
    body?: string;
    channels?: TourNotificationChannels;
  },
): Promise<TourNotificationResult> {
  const row = inquiry as Record<string, unknown>;
  const guestEmail = textField(row, "email");
  const wantsEmail = input.channels?.viaEmail !== false;
  // A tour made in the portal is answered by email + the resident portal inbox, never by text.
  const portalChannel = noticeChannelFor(inquiry) === "portal";
  const wantsSms = input.channels?.viaSms !== false && !portalChannel;
  const managerUserId = input.window.managerUserId || textField(row, "managerUserId");
  const guestPhone = textField(row, "phone") || null;
  const smsPurpose = input.kind === "canceled" ? "tour_canceled" : "tour_rescheduled";
  const smsEligibility = wantsSms
    ? await resolveTourSmsEligibility(db, {
        managerUserId,
        guestPhone,
        explicitOptIn: inquirySmsConsent(inquiry),
        purpose: smsPurpose,
        allowConversationEvidence: inquiryAllowsConversationSmsEvidence(inquiry),
        inquiryId: textField(row, "id") || null,
      })
    : null;
  const replyTo = wantsEmail && guestEmail.includes("@")
    ? buildReplyAddress(managerUserId, guestEmail)
    : null;
  const propertyId = textField(row, "propertyId");
  const propertyAddress = await resolvePropertyAddressForTour(db, propertyId);
  const origin = resolveEmailLinkBaseUrl();
  const ctx = buildTourNotificationContext({
    origin,
    guestName: textField(row, "name") || "Guest",
    guestEmail,
    guestPhone,
    propertyId,
    propertyTitle: textField(row, "propertyTitle") || "Property",
    propertyAddress,
    roomLabel: textField(row, "roomLabel") || null,
    tourFormat: textField(row, "tourFormat") || null,
    tourStartIso: input.window.start,
    tourEndIso: input.window.end,
    notes: textField(row, "notes") || null,
    managerLabel: input.window.adminLabel || textField(row, "adminLabel") || null,
    instructions: input.instructions || null,
    tourInquiryId: textField(row, "id") || null,
    replyOptions: {
      smsSelected: wantsSms,
      smsAvailable: smsEligibility?.eligible === true,
      emailSelected: wantsEmail,
      emailReplyAvailable: Boolean(replyTo),
    },
  });

  const canceled = input.kind === "canceled";
  const subject = input.subject?.trim() || (canceled ? TOUR_CANCELED_TENANT_SUBJECT : TOUR_RESCHEDULED_TENANT_SUBJECT);
  const previous = {
    startIso: input.previousWindow?.start ?? input.window.start,
    endIso: input.previousWindow?.end ?? input.window.end,
  };
  const authoritativeDefault = canceled
    ? buildTourCanceledTenantBody(ctx, input.reason)
    : input.proposalRecordId
      ? buildTourRescheduleConfirmRequestBody(ctx, previous)
      : buildTourRescheduledTenantBody(ctx, previous, input.reason);
  const suppliedBody = input.body?.trim();
  const suppliedDefaultMatch = suppliedBody && !canceled
    ? generatedTourChangeBodyMatch(ctx, {
      pendingProposal: Boolean(input.proposalRecordId),
      previous,
      reason: input.reason,
    }, suppliedBody)
    : null;
  // A client preview is deliberately conservative because it cannot authorize
  // SMS or inspect Reply-To secrets. Preserve that exact generated default when
  // it makes no promise the server cannot honor. If it overclaims a reply path,
  // replace it with the server-authoritative default. Unknown text is manager
  // prose and remains untouched.
  const changeText = !suppliedBody
    ? authoritativeDefault
    : suppliedDefaultMatch?.generated && !suppliedDefaultMatch.replyPathClaimsAreAvailable
      ? authoritativeDefault
      : suppliedBody;
  const text = portalChannel ? withResidentPortalLink(changeText, "tour") : changeText;

  let inboxSent = false;
  let inboxAttempted = false;
  const hasGuestEmail = guestEmail.includes("@");
  if (hasGuestEmail) {
    const manager = await resolveTourManagerIdentity(db, managerUserId);
    const residentUserId = await linkedTourNoticeOwner(db, textField(row, "id") || null, propertyId || null);
    inboxAttempted = Boolean(manager && propertyId && residentUserId);
    if (manager && propertyId && residentUserId) inboxSent = await appendResidentPropertyManagerInboxMessage(db, {
      participantEmail: guestEmail, residentUserId, managerUserId, propertyId, propertyTitle: ctx.propertyTitle || propertyId,
      subject, body: text, counterpartyEmail: manager.email, managerName: manager.name, fromName: manager.name,
      messageId: `tour:${textField(row, "id") || propertyId}:${input.kind}:${input.rescheduleGeneration?.trim() || `${input.previousWindow?.start ?? ""}:${input.previousWindow?.end ?? ""}:${input.window.start}:${input.window.end}`}`,
    }).then(() => true).catch(() => false);
  }
  const email = wantsEmail
    ? hasGuestEmail
      ? await deliverEmail(
          [guestEmail],
          subject,
          text,
          undefined,
          replyTo,
          { db, managerUserId },
        )
      : { sent: false, skipped: true, error: "Guest email is required to notify the guest." }
    : { sent: false, skipped: true };

  const listingLink = propertyId ? `${origin}/rent/listings/${propertyId}` : origin;
  const sms: TourNotificationResult["sms"] = wantsSms ? await textTourGuest({
    db,
    managerUserId,
    guestEmail,
    guestPhone,
    smsConsent: inquirySmsConsent(inquiry),
    purpose: smsPurpose,
    inquiryId: textField(row, "id") || null,
    allowConversationEvidence: inquiryAllowsConversationSmsEvidence(inquiry),
    ...(smsEligibility ? { eligibility: smsEligibility } : {}),
    // Include the predecessor window. A → B → A is a fresh reschedule and
    // must not be suppressed by the first historical A notification; a retry
    // of the same B → A operation keeps this exact stable key.
    deliveryKey: `${textField(row, "id") || "tour"}:${input.rescheduleGeneration?.trim() || `${input.previousWindow?.start ?? ""}:${input.previousWindow?.end ?? ""}:${input.window.start}:${input.window.end}`}`,
    text: canceled
      ? `PropLane: your tour of ${ctx.propertyTitle} on ${formatTourTimeRange(
          input.previousWindow?.start ?? input.window.start,
          input.previousWindow?.end ?? input.window.end,
        )} was cancelled. Please do not travel to the property. Book another: ${listingLink}. Reply STOP to opt out, HELP for help.`
      : `PropLane: your tour of ${ctx.propertyTitle} moved to ${formatTourTimeRange(
          input.window.start,
          input.window.end,
        )}. Does this new time work for you? Reply YES to confirm or reply with another time that works. Details: ${listingLink}. Reply STOP to opt out, HELP for help.`,
  }) : { requested: false, sent: false, skipped: true };

  if (!canceled && (sms.sent || sms.accepted)) {
    const { recordTourRescheduleSmsProposal } = await import("@/lib/tour-reschedule-sms-reply.server");
    const proposalRecorded = await recordTourRescheduleSmsProposal(db, {
      managerUserId: input.window.managerUserId || textField(row, "managerUserId"),
      inquiryId: textField(row, "id"),
      phone: textField(row, "phone"),
      start: input.window.start,
      end: input.window.end,
      generation: input.rescheduleGeneration,
      recordId: input.proposalRecordId,
    }).catch(() => false);
    if (!proposalRecorded) {
      sms.error = "SMS was accepted, but its tour confirmation state was not saved.";
    }
  }

  // `skipped` means "deliberately not sent" (a sandbox address, no mail
  // provider) and reads as "nothing went wrong". A failed send is not that.
  return notificationResult(
    { requested: wantsEmail, ...email },
    sms,
    inboxSent
      ? { sent: true }
      : inboxAttempted
        ? { sent: false, error: "PropLane inbox notification was not saved." }
        : { sent: false },
  );
}

export async function notifyTenantTourCanceled(
  db: Db,
  /** Unused: origins come from `app-url.ts`, never the incoming request (see below). */
  req: Request | null,
  inquiry: TourInquiryPayload,
  window: { start: string; end: string; managerUserId?: string; adminLabel?: string },
  reason?: string | null,
  opts?: { subject?: string; body?: string },
  channels?: TourNotificationChannels,
): Promise<TourNotificationResult> {
  const row = inquiry as Record<string, unknown>;
  const managerUserId = textField(row, "managerUserId");
  const inquiryId = textField(row, "id") || null;
  return traceSystemNotification({
    domain: "tour_lifecycle_sms",
    managerUserId,
    entityId: inquiryId,
    cadence: "tour_canceled",
    run: () => notifyTenantTourChanged(db, req, inquiry, { kind: "canceled", window, reason, ...opts, channels }),
    summarize: summarizeTourLifecycleNotification,
  });
}

export async function notifyTenantTourRescheduled(
  db: Db,
  /** Unused: origins come from `app-url.ts`, never the incoming request (see below). */
  req: Request | null,
  inquiry: TourInquiryPayload,
  input: {
    window: { start: string; end: string; managerUserId?: string; adminLabel?: string };
    previousWindow: { start: string; end: string };
    reason?: string | null;
    instructions?: string | null;
    rescheduleGeneration?: string;
    proposalRecordId?: string;
    subject?: string;
    body?: string;
    channels?: TourNotificationChannels;
  },
): Promise<TourNotificationResult> {
  const row = inquiry as Record<string, unknown>;
  const managerUserId = input.window.managerUserId || textField(row, "managerUserId");
  const inquiryId = textField(row, "id") || null;
  return traceSystemNotification({
    domain: "tour_lifecycle_sms",
    managerUserId,
    entityId: inquiryId,
    cadence: "tour_rescheduled",
    run: () => notifyTenantTourChanged(db, req, inquiry, { kind: "rescheduled", ...input }),
    summarize: summarizeTourLifecycleNotification,
  });
}

async function deliverTenantTourConfirmed(
  db: Db,
  /** Unused: origins come from `app-url.ts`, never the incoming request (see below). */
  req: Request | null,
  inquiry: TourInquiryPayload,
  window: { start: string; end: string; managerUserId: string; adminLabel?: string },
  instructions?: string,
  opts?: { subject?: string; body?: string },
  channels?: TourNotificationChannels,
): Promise<TourNotificationResult> {
  const guestEmail = textField(inquiry as Record<string, unknown>, "email");
  const wantsEmail = channels?.viaEmail !== false;
  const portalChannel = noticeChannelFor(inquiry) === "portal";
  const wantsSms = channels?.viaSms !== false && !portalChannel;
  const propertyId = textField(inquiry as Record<string, unknown>, "propertyId");
  const propertyAddress = await resolvePropertyAddressForTour(db, propertyId);
  const origin = resolveEmailLinkBaseUrl();
  const ctx = buildTourNotificationContext({
    origin,
    guestName: textField(inquiry as Record<string, unknown>, "name") || "Guest",
    guestEmail,
    guestPhone: textField(inquiry as Record<string, unknown>, "phone") || null,
    propertyId,
    propertyTitle: textField(inquiry as Record<string, unknown>, "propertyTitle") || "Property",
    propertyAddress,
    roomLabel: textField(inquiry as Record<string, unknown>, "roomLabel") || null,
    tourFormat: textField(inquiry as Record<string, unknown>, "tourFormat") || null,
    tourStartIso: window.start,
    tourEndIso: window.end,
    notes: textField(inquiry as Record<string, unknown>, "notes") || null,
    managerLabel: window.adminLabel || textField(inquiry as Record<string, unknown>, "adminLabel") || null,
    instructions: instructions || null,
    tourInquiryId: textField(inquiry as Record<string, unknown>, "id") || null,
  });

  const subject = opts?.subject?.trim() || TOUR_CONFIRMED_TENANT_SUBJECT;
  const confirmedText = opts?.body?.trim() || buildTourConfirmedTenantBody(ctx);
  const text = portalChannel ? withResidentPortalLink(confirmedText, "tour") : confirmedText;
  // The generated HTML has no portal link, so a portal-channel mail sends the text body (which carries it).
  const html = opts?.body?.trim() || portalChannel ? undefined : buildTourConfirmedTenantHtml(ctx);

  let inboxSent = false;
  let inboxAttempted = false;
  const hasGuestEmail = guestEmail.includes("@");
  if (hasGuestEmail) {
    const manager = await resolveTourManagerIdentity(db, window.managerUserId);
    const residentUserId = await linkedTourNoticeOwner(db, textField(inquiry as Record<string, unknown>, "id") || null, propertyId || null);
    inboxAttempted = Boolean(manager && propertyId && residentUserId);
    if (manager && propertyId && residentUserId) inboxSent = await appendResidentPropertyManagerInboxMessage(db, {
      participantEmail: guestEmail, residentUserId, managerUserId: window.managerUserId, propertyId, propertyTitle: ctx.propertyTitle || propertyId,
      subject, body: text, counterpartyEmail: manager.email, managerName: manager.name, fromName: manager.name,
      messageId: `tour:${textField(inquiry as Record<string, unknown>, "id") || propertyId}:confirmed:${window.start}:${window.end}`,
    }).then(() => true).catch(() => false);
  }
  const email = wantsEmail
    ? hasGuestEmail
      ? await deliverEmail(
          [guestEmail],
          subject,
          text,
          html,
          buildReplyAddress(window.managerUserId, guestEmail),
          { db, managerUserId: window.managerUserId },
        )
      : { sent: false, skipped: true, error: "Guest email is required to send tour confirmation." }
    : { sent: false, skipped: true };

  const guestPhone = textField(inquiry as Record<string, unknown>, "phone") || null;
  const listingLink = propertyId ? `${origin}/rent/listings/${propertyId}` : origin;
  const sms: TourNotificationResult["sms"] = wantsSms ? await textTourGuest({
    db,
    managerUserId: window.managerUserId,
    guestEmail,
    guestPhone,
    smsConsent: inquirySmsConsent(inquiry),
    purpose: "tour_confirmed",
    inquiryId: textField(inquiry as Record<string, unknown>, "id") || null,
    allowConversationEvidence: inquiryAllowsConversationSmsEvidence(inquiry),
    deliveryKey: `${textField(inquiry as Record<string, unknown>, "id") || "tour"}:${window.start}:${window.end}`,
    text: `PropLane: your tour of ${ctx.propertyTitle} is confirmed${
      ctx.tourStartIso ? ` for ${formatTourTimeRange(ctx.tourStartIso, ctx.tourEndIso)}` : ""
    }.${instructions ? ` ${instructions.trim()}` : ""} Reply here with any questions. Details: ${listingLink}. Reply STOP to opt out, HELP for help.`,
  }) : { requested: false, sent: false, skipped: true };

  return notificationResult(
    { requested: wantsEmail, ...email },
    { ...sms, requested: wantsSms },
    inboxSent
      ? { sent: true }
      : inboxAttempted
        ? { sent: false, error: "PropLane inbox notification was not saved." }
        : { sent: false },
  );
}

export async function notifyTenantTourConfirmed(
  db: Db,
  req: Request | null,
  inquiry: TourInquiryPayload,
  window: { start: string; end: string; managerUserId: string; adminLabel?: string },
  instructions?: string,
  opts?: { subject?: string; body?: string },
  channels?: TourNotificationChannels,
): Promise<TourNotificationResult> {
  // The manager's own copy (PLAN-0915): with auto-confirm on, nobody in the
  // office used to hear that a tour had been booked.
  // Lazy: this module sits on the resident portal's import path, and the bus
  // pulls in the whole delivery layer.
  void import("@/lib/tour-events.server").then(({ emitTourManagerEvent }) => emitTourManagerEvent(db, {
    event: "confirmed",
    managerUserId: window.managerUserId,
    tourId: textField(inquiry as Record<string, unknown>, "id") || `${window.start}:${window.end}`,
    guestName: textField(inquiry as Record<string, unknown>, "name") || "A guest",
    guestEmail: textField(inquiry as Record<string, unknown>, "email") || undefined,
    propertyTitle: textField(inquiry as Record<string, unknown>, "propertyTitle") || undefined,
    propertyId: textField(inquiry as Record<string, unknown>, "propertyId") || undefined,
    whenLabel: formatTourTimeRange(window.start, window.end),
  })).catch(() => undefined);
  return traceSystemNotification({
    domain: "tour_lifecycle_sms",
    managerUserId: window.managerUserId,
    entityId: textField(inquiry as Record<string, unknown>, "id") || null,
    cadence: "tour_confirmed",
    run: () => deliverTenantTourConfirmed(db, req, inquiry, window, instructions, opts, channels),
    summarize: summarizeTourLifecycleNotification,
  });
}
