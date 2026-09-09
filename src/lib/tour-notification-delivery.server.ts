/**
 * Server-side tour notification delivery (Resend email + Axis inbox records).
 */

import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { formatPacificDateTime } from "@/lib/pacific-time";
import { appendResidentPropertyManagerInboxMessage, appendManagerPropertyLeadInboxMessage } from "@/lib/property-manager-inbox-thread.server";
import { sendManagerNotificationSms } from "@/lib/manager-notification-routing.server";
import { sendResidentOutboundSms } from "@/lib/resident-outbound-sms.server";
import { recordScopedSmsConsent } from "@/lib/sms-consent";
import { buildConversationKey } from "@/lib/sms-conversation-identity";
import { fetchManagerSmsConversations } from "@/lib/manager-sms-messages.server";
import { resolveExistingApplicantConversation } from "@/lib/application-lifecycle-sms.server";
import { shouldSkipOutboundEmail } from "@/lib/portal-sandbox-accounts";
import {
  resolveManagerRecipientProfiles,
  resolvePropertyLeadRecipientIds,
} from "@/lib/co-manager-notification-recipients.server";
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
  buildTourRequestRemovedTenantBody,
  buildTourRescheduledTenantBody,
  formatTourTimeRange,
  buildTourRequestTenantBody,
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

async function deliverEmail(to: string[], subject: string, text: string, html?: string): Promise<{ sent: boolean; skipped: boolean; error?: string }> {
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
  const from = process.env.RESEND_FROM?.trim() || "PropLane <onboarding@resend.dev>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: recipients,
      subject,
      text,
      ...(html ? { html } : {}),
    }),
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
  sms: { requested: boolean; sent: boolean; accepted?: boolean; skipped: boolean; error?: string };
  inbox: { sent: boolean; error?: string };
};

function notificationResult(
  email: TourNotificationResult["email"],
  sms: TourNotificationResult["sms"],
  inbox: TourNotificationResult["inbox"] = { sent: false },
): TourNotificationResult {
  const smsMissing = sms.requested && !sms.sent && !sms.accepted;
  const failed = Boolean(email.error || sms.error || smsMissing || inbox.error);
  return {
    ok: !failed,
    skipped: email.skipped && sms.skipped,
    ...(sms.error || smsMissing || email.error || inbox.error
      ? { error: sms.error || (smsMissing ? "SMS was not sent." : inbox.error || email.error) }
      : {}),
    email,
    sms,
    inbox,
  };
}

async function upsertInboxThread(
  db: Db,
  input: {
    scope: string;
    ownerUserId: string | null;
    participantEmail: string;
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
  },
): Promise<boolean> {
  const when = formatPacificDateTime(new Date());
  const preview = (input.preview ?? input.body).slice(0, 100).replace(/\n/g, " ");
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 6);
  const threadId = `tour_${input.folder}_${ts}_${rand}`;
  const { error } = await db.from("portal_inbox_thread_records").upsert(
    {
      id: threadId,
      scope: input.scope,
      owner_user_id: input.ownerUserId,
      participant_email: input.participantEmail.trim().toLowerCase(),
      thread_type: input.threadType ?? "tour_notification",
      row_data: {
        id: threadId,
        folder: input.folder,
        from: input.fromName,
        email: input.folder === "sent" ? input.toLine : input.fromEmail,
        subject: input.subject,
        preview,
        body: input.body,
        time: when,
        unread: input.folder === "inbox",
        scope: input.scope,
        ...(input.rootOutbound ? { rootOutbound: true } : {}),
        ...(input.messages?.length ? { messages: input.messages } : {}),
      },
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
  return !error;
}

/** Prospect/resident inbox row for tour acks, lead invites, etc. — backfilled on account creation. */
export async function recordResidentProspectInboxMessage(
  db: Db,
  input: {
    participantEmail: string;
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
  const managerUserId = input.managerUserId?.trim() ?? "";
  const propertyId = input.propertyId?.trim() ?? "";
  const propertyTitle = input.propertyTitle?.trim() ?? "";
  if (managerUserId && propertyId) {
    await appendResidentPropertyManagerInboxMessage(db, {
      participantEmail: input.participantEmail,
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
  const { data: guestProfile } = await db.from("profiles").select("id").eq("email", guestEmail).maybeSingle();
  const ownerUserId = (guestProfile?.id as string | null) ?? null;
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
  });
}

export type TourInquiryPayload = {
  name?: unknown;
  email?: unknown;
  phone?: unknown;
  /** Explicit A2P/CTIA SMS opt-in captured on the tours-contact form. */
  smsConsent?: unknown;
  notes?: unknown;
  propertyId?: unknown;
  propertyTitle?: unknown;
  roomLabel?: unknown;
  managerUserId?: unknown;
  adminLabel?: unknown;
  proposedStart?: unknown;
  proposedEnd?: unknown;
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

  for (const recipient of recipients) {
    let smsConversationKey: string | undefined;
    const guestPhone = textField(inquiry as Record<string, unknown>, "phone");
    if (guestPhone) try {
      const conversations = await fetchManagerSmsConversations(db, recipient.userId, { scopeManagerIdsOverride: [recipient.userId], provisionWorkNumber: false });
      const existing = resolveExistingApplicantConversation(conversations.residents, { managerUserId: recipient.userId, applicantPhone: guestPhone, workNumber: conversations.workNumber });
      if (existing.kind === "matched") smsConversationKey = existing.conversation.conversationKey;
    } catch { smsConversationKey = undefined; }
    await appendManagerPropertyLeadInboxMessage(db, recipient.userId, {
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
  }

  const email = await deliverEmail(
    recipients.map((recipient) => recipient.email),
    subject,
    text,
  );

  // Also text any recipient with a forward-enabled phone on file (e.g. the
  // admin's own DB-backed number) — a tour request shouldn't wait on email.
  const smsText = `PropLane: new tour request${ctx.propertyTitle ? ` — ${ctx.propertyTitle}` : ""}${
    ctx.tourStartIso ? ` (${formatTourTimeRange(ctx.tourStartIso, ctx.tourEndIso)})` : ""
  }. ${ctx.guestName} requested a tour. Check your PropLane inbox for details.`;
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
}): Promise<TourNotificationResult["sms"]> {
  const phone = (args.guestPhone ?? "").trim();
  if (!phone) return { requested: true, sent: false, skipped: true };
  if (!args.managerUserId) return { requested: true, sent: false, skipped: true };
  // Carrier compliance (A2P 10DLC / CTIA): a prospect is texted ONLY when they
  // explicitly opted in on the tours-contact form. Absence of a prior STOP is
  // NOT consent — the send-time opt-out ledger fails open (see
  // resident-outbound-sms.server.ts), so the positive opt-in captured with the
  // lead is the load-bearing gate. This does not weaken STOP/HELP handling: a
  // later STOP still supersedes the recorded opt-in in the sms_consent ledger.
  if (args.smsConsent !== true) return { requested: true, sent: false, skipped: true };
  const conversationKey = buildConversationKey({
    ownerManagerUserId: args.managerUserId,
    role: "prospect",
    counterpartyPhone: phone,
  });
  const scoped = await recordScopedSmsConsent(args.db, phone, {
    managerUserId: args.managerUserId,
    messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID?.trim() ?? null,
    purpose: args.purpose,
    sendClass: "transactional",
    conversationKey,
    eventType: "granted",
    source: "tour_inquiry_opt_in",
    wordingVersion: "tour-sms-consent-v1",
    evidence: { inquiryId: args.inquiryId },
  }).catch(() => ({ ok: false as const }));
  if (!scoped.ok) return { requested: true, sent: false, skipped: false, error: "Could not record SMS consent." };
  const result: { sent: boolean; accepted?: boolean; error?: string } = await sendResidentOutboundSms({
    to: phone,
    text: args.text,
    openThread: {
      managerUserId: args.managerUserId,
      residentEmail: args.guestEmail,
      topic: "leasing",
      counterpartyRole: "prospect",
    },
    purpose: args.purpose,
    sendClass: "transactional",
    dedupeKey: `${args.purpose}_${args.deliveryKey ?? args.inquiryId ?? conversationKey}`,
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
    ...(result.error ? { error: result.error } : {}),
  };
}

/** Read the explicit SMS opt-in flag persisted alongside a tour inquiry. */
function inquirySmsConsent(inquiry: TourInquiryPayload): boolean {
  return (inquiry as Record<string, unknown>).smsConsent === true;
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

  const subject = TOUR_REQUEST_TENANT_SUBJECT;
  const text = buildTourRequestTenantBody(ctx);
  const email = await deliverEmail([guestEmail], subject, text);

  await recordResidentProspectInboxMessage(db, {
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
  const accountPrompt = ctx.createAccountUrl?.trim()
    ? ` Create your free account to track it: ${ctx.createAccountUrl.trim()}`
    : "";
  await textTourGuest({
    db,
    managerUserId: textField(inquiry as Record<string, unknown>, "managerUserId"),
    guestEmail,
    guestPhone,
    smsConsent: inquirySmsConsent(inquiry),
    purpose: "tour_request_received",
    inquiryId: textField(inquiry as Record<string, unknown>, "id") || null,
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
): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
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
  const text = opts?.body?.trim() || buildTourRequestRemovedTenantBody(ctx);
  const managerUserId = textField(row, "managerUserId");

  await recordResidentProspectInboxMessage(db, {
    participantEmail: guestEmail,
    subject,
    body: text,
    fromName: "PropLane Tours",
    managerUserId: managerUserId || undefined,
    propertyId: propertyId || undefined,
    propertyTitle: ctx.propertyTitle,
  });

  const email = await deliverEmail([guestEmail], subject, text);

  const listingLink = propertyId ? `${origin}/rent/listings/${propertyId}` : origin;
  await textTourGuest({
    db,
    managerUserId,
    guestEmail,
    guestPhone: textField(row, "phone") || null,
    smsConsent: inquirySmsConsent(inquiry),
    purpose: "tour_request_removed",
    inquiryId: textField(row, "id") || null,
    text: `PropLane: your tour request for ${ctx.propertyTitle}${
      tourStartIso && tourEndIso ? ` (${formatTourTimeRange(tourStartIso, tourEndIso)})` : ""
    } was removed by the property team. Request another time: ${listingLink}. Reply STOP to opt out, HELP for help.`,
  });

  if (email.error) return { ok: false, skipped: false, error: email.error };
  return { ok: true, skipped: email.skipped };
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
  const wantsSms = input.channels?.viaSms !== false;
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
    tourStartIso: input.window.start,
    tourEndIso: input.window.end,
    notes: textField(row, "notes") || null,
    managerLabel: input.window.adminLabel || textField(row, "adminLabel") || null,
    instructions: input.instructions || null,
    tourInquiryId: textField(row, "id") || null,
  });

  const canceled = input.kind === "canceled";
  const subject = input.subject?.trim() || (canceled ? TOUR_CANCELED_TENANT_SUBJECT : TOUR_RESCHEDULED_TENANT_SUBJECT);
  const text =
    input.body?.trim() ||
    (canceled
      ? buildTourCanceledTenantBody(ctx, input.reason)
      : buildTourRescheduledTenantBody(
        ctx,
        {
          startIso: input.previousWindow?.start ?? input.window.start,
          endIso: input.previousWindow?.end ?? input.window.end,
        },
        input.reason,
      ));

  let inboxSent = false;
  const hasGuestEmail = guestEmail.includes("@");
  if (hasGuestEmail) {
    const managerUserId = input.window.managerUserId || textField(row, "managerUserId");
    const manager = await resolveTourManagerIdentity(db, managerUserId);
    if (manager && propertyId) inboxSent = await appendResidentPropertyManagerInboxMessage(db, {
      participantEmail: guestEmail, managerUserId, propertyId, propertyTitle: ctx.propertyTitle || propertyId,
      subject, body: text, counterpartyEmail: manager.email, managerName: manager.name, fromName: manager.name,
      messageId: `tour:${textField(row, "id") || propertyId}:${input.kind}:${input.rescheduleGeneration?.trim() || `${input.previousWindow?.start ?? ""}:${input.previousWindow?.end ?? ""}:${input.window.start}:${input.window.end}`}`,
    }).then(() => true).catch(() => false);
  }
  const email = wantsEmail
    ? hasGuestEmail
      ? await deliverEmail([guestEmail], subject, text)
      : { sent: false, skipped: true, error: "Guest email is required to notify the guest." }
    : { sent: false, skipped: true };

  const listingLink = propertyId ? `${origin}/rent/listings/${propertyId}` : origin;
  const sms: TourNotificationResult["sms"] = wantsSms ? await textTourGuest({
    db,
    managerUserId: input.window.managerUserId || textField(row, "managerUserId"),
    guestEmail,
    guestPhone: textField(row, "phone") || null,
    smsConsent: inquirySmsConsent(inquiry),
    purpose: canceled ? "tour_canceled" : "tour_rescheduled",
    inquiryId: textField(row, "id") || null,
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
      : hasGuestEmail
        ? { sent: false, error: "PropLane inbox notification was not saved." }
        : { sent: false },
  );
}

export async function notifyTenantTourCanceled(
  db: Db,
  /** Unused: origins come from `app-url.ts`, never the incoming request (see below). */
  req: Request | null,
  inquiry: TourInquiryPayload,
  window: { start: string; end: string; adminLabel?: string },
  reason?: string | null,
  opts?: { subject?: string; body?: string },
  channels?: TourNotificationChannels,
): Promise<TourNotificationResult> {
  return notifyTenantTourChanged(db, req, inquiry, { kind: "canceled", window, reason, ...opts, channels });
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
  return notifyTenantTourChanged(db, req, inquiry, { kind: "rescheduled", ...input });
}

export async function notifyTenantTourConfirmed(
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
  const wantsSms = channels?.viaSms !== false;
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
  const text = opts?.body?.trim() || buildTourConfirmedTenantBody(ctx);
  const html = opts?.body?.trim() ? undefined : buildTourConfirmedTenantHtml(ctx);

  let inboxSent = false;
  const hasGuestEmail = guestEmail.includes("@");
  if (hasGuestEmail) {
    const manager = await resolveTourManagerIdentity(db, window.managerUserId);
    if (manager && propertyId) inboxSent = await appendResidentPropertyManagerInboxMessage(db, {
      participantEmail: guestEmail, managerUserId: window.managerUserId, propertyId, propertyTitle: ctx.propertyTitle || propertyId,
      subject, body: text, counterpartyEmail: manager.email, managerName: manager.name, fromName: manager.name,
      messageId: `tour:${textField(inquiry as Record<string, unknown>, "id") || propertyId}:confirmed:${window.start}:${window.end}`,
    }).then(() => true).catch(() => false);
  }
  const email = wantsEmail
    ? hasGuestEmail
      ? await deliverEmail([guestEmail], subject, text, html)
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
      : hasGuestEmail
        ? { sent: false, error: "PropLane inbox notification was not saved." }
        : { sent: false },
  );
}
