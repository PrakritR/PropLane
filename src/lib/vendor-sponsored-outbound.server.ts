import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { filterRecipientsBySenderScope } from "@/lib/inbox-recipient-scope";
import { PRIMARY_ADMIN_EMAIL } from "@/lib/auth/primary-admin";
import { attachmentMetaFromUrls } from "@/lib/inbox-attachments";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import {
  commitInboxThreadReply,
  deliverPortalMessageThreadSide,
  resolveInboxThreadReplyTarget,
  scopeForRole,
} from "@/lib/portal-inbox-delivery";
import {
  createVendorWorkIdentityDeliveryProvider,
  deliverVendorWorkIdentity,
  type VendorDeliveryProvider,
  type VendorIdentityChannel,
} from "@/lib/vendor-work-identity-delivery.server";
import { aggregateVendorSponsoredDelivery } from "@/lib/vendor-sponsored-delivery-state";
import { formatInboxStamp } from "@/lib/portal-inbox-storage";
import { normalizeE164 } from "@/lib/phone-e164";
import { touchVendorNumberConversation } from "@/lib/vendor-number-conversations.server";
import { withoutOwnerLinks } from "@/lib/co-manager-team-roles";
import { normalizeRecordRef, type RecordRef } from "@/lib/portals/record-kinds";

type Recipient = { userId: string | null; email: string; role: string; phone?: string | null };

type ReplyBinding = {
  recipient: string;
  recipient_user_id: string | null;
};

async function replyBindingFor(
  db: SupabaseClient,
  input: { vendorUserId: string; threadId: string; channel: VendorIdentityChannel },
): Promise<ReplyBinding | null> {
  const { data, error } = await db
    .from("vendor_work_identity_reply_bindings")
    .select("recipient,recipient_user_id")
    .eq("vendor_user_id", input.vendorUserId)
    .eq("thread_id", input.threadId)
    .eq("channel", input.channel)
    .maybeSingle();
  if (error || !data) return null;
  const recipient = String((data as ReplyBinding).recipient ?? "").trim().toLowerCase();
  return recipient ? { recipient, recipient_user_id: (data as ReplyBinding).recipient_user_id ?? null } : null;
}

export async function bindVendorReplyTarget(
  db: SupabaseClient,
  input: { vendorUserId: string; threadId: string; channel: VendorIdentityChannel; recipient: string; recipientUserId: string | null; messageId: string },
): Promise<void> {
  const { data: identity, error: identityError } = await db
    .from("vendor_work_identities")
    .select("id")
    .eq("vendor_user_id", input.vendorUserId)
    .maybeSingle();
  if (identityError || !identity?.id) throw new Error("Vendor identity binding unavailable.");
  const binding = {
    identity_id: identity.id,
    vendor_user_id: input.vendorUserId,
    thread_id: input.threadId,
    channel: input.channel,
    recipient: input.recipient,
    recipient_user_id: input.recipientUserId,
    source_message_id: input.messageId,
  };
  // Bindings are write-once authorization facts. A conflict is valid only when
  // it names the exact same destination; no retry is allowed to retarget an
  // existing thread, even from service-role application code.
  const { error: insertError } = await db.from("vendor_work_identity_reply_bindings").insert(binding);
  if (!insertError) return;
  if (String((insertError as { code?: string }).code ?? "") !== "23505") {
    throw new Error("Vendor identity binding unavailable.");
  }
  const existing = await replyBindingFor(db, {
    vendorUserId: input.vendorUserId,
    threadId: input.threadId,
    channel: input.channel,
  });
  if (!existing || existing.recipient !== input.recipient.trim().toLowerCase() || existing.recipient_user_id !== input.recipientUserId) {
    throw new Error("Vendor identity binding conflict.");
  }
}

export type VendorSponsoredOutboundRequest = {
  channel: VendorIdentityChannel;
  subject: string;
  text: string;
  sendId: string;
  /** Existing conversation to reply to. The recipient is resolved from the row, never the request. */
  threadId?: string;
  /** Server resolves this profile and then proves it is a linked manager/co-manager. */
  recipientUserId?: string;
  recipientAdmin?: boolean;
  attachmentUrls?: string[];
  /**
   * The job this message is about. A hint only: the server re-derives that the
   * vendor is on that service (assigned, or holding a live offer) and that its
   * manager is the recipient before stamping it; anything else is dropped.
   */
  recordRef?: RecordRef;
  /** Authorization/target resolution only; never creates an outbox or calls a provider. */
  preflight?: boolean;
};

export type VendorSponsoredOutboundResult =
  | { ok: true; providerMessageId: string | null; delivery: "sending" | "failed" | "sent" }
  | { ok: false; error: "invalid_request" | "recipient_unlinked" | "conversation_unavailable" | "delivery_refused"; reason?: string };

async function profileById(db: SupabaseClient, id: string): Promise<Recipient | null> {
  const { data } = await db.from("profiles").select("id,email,role,phone").eq("id", id).maybeSingle();
  const email = String(data?.email ?? "").trim().toLowerCase();
  const userId = String(data?.id ?? "").trim();
  return userId && email ? { userId, email, role: String(data?.role ?? "").trim().toLowerCase(), phone: String(data?.phone ?? "").trim() || null } : null;
}

async function profileByEmail(db: SupabaseClient, email: string): Promise<Recipient | null> {
  const { data } = await db.from("profiles").select("id,email,role,phone").eq("email", email).maybeSingle();
  const resolved = String(data?.email ?? "").trim().toLowerCase();
  const userId = String(data?.id ?? "").trim();
  return userId && resolved ? { userId, email: resolved, role: String(data?.role ?? "").trim().toLowerCase(), phone: String(data?.phone ?? "").trim() || null } : null;
}

/** Exact vendor-user linkage only — never the legacy directory email fallback. */
async function vendorMayReachManager(db: SupabaseClient, vendorUserId: string, recipientUserId: string): Promise<boolean> {
  const { data: ownedRows } = await db
    .from("manager_vendor_records")
    .select("manager_user_id")
    .eq("vendor_user_id", vendorUserId);
  const ownerIds = [...new Set((ownedRows ?? []).map((row) => String(row.manager_user_id ?? "").trim()).filter(Boolean))];
  if (ownerIds.includes(recipientUserId)) return true;
  if (ownerIds.length === 0) return false;
  // Accepted account links are the authoritative co-manager relationship. The
  // portal mirror carries convenience fields and must not authorize a sender.
  const { data: coManagerRows } = withoutOwnerLinks(await db
    .from("account_link_invites")
    .select("invitee_user_id, team_role")
    .eq("status", "accepted")
    .in("inviter_user_id", ownerIds)
    .eq("invitee_user_id", recipientUserId));
  return (coManagerRows ?? []).some((row) => String(row.invitee_user_id ?? "").trim() === recipientUserId);
}

/**
 * The PropLane account on the other end of an existing thread, if any. A reply
 * binding (server-written) wins; a thread the manager started has none, so the
 * thread's own `email` names the profile. That field is display data, so it only
 * ever picks WHICH linked account — `canReceiveInApp` still proves the link.
 */
async function threadCounterpartProfile(
  db: SupabaseClient,
  target: { rowData: Record<string, unknown> },
  binding: ReplyBinding | null,
): Promise<Recipient | null> {
  if (binding) {
    if (binding.recipient_user_id) return profileById(db, binding.recipient_user_id);
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(binding.recipient) ? profileByEmail(db, binding.recipient) : null;
  }
  const email = String(target.rowData.email ?? "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? profileByEmail(db, email) : null;
}

/** The scope a PropLane-user counterpart is delivered under, or null when the vendor may not reach them. */
async function inAppRoleFor(db: SupabaseClient, vendorUserId: string, profile: Recipient): Promise<"manager" | "admin" | null> {
  if (profile.email === PRIMARY_ADMIN_EMAIL.trim().toLowerCase()) return "admin";
  return profile.userId && (await vendorMayReachManager(db, vendorUserId, profile.userId)) ? "manager" : null;
}

/**
 * Re-derive that the vendor is on this service and that `managerUserId` owns it.
 * `null` drops the ref (the send still goes); the property it names places the
 * manager-side copy in that service's workspace.
 */
async function verifiedJobRef(
  db: SupabaseClient,
  vendorUserId: string,
  managerUserId: string,
  ref: RecordRef | undefined,
): Promise<{ recordRef: RecordRef; propertyId?: string } | null> {
  const recordRef = normalizeRecordRef(ref);
  if (!recordRef || recordRef.kind !== "service") return null;
  const { data: record } = await db
    .from("portal_work_order_records")
    .select("manager_user_id, vendor_user_id, row_data")
    .eq("id", recordRef.id)
    .maybeSingle();
  if (!record || String(record.manager_user_id ?? "") !== managerUserId) return null;
  if (String(record.vendor_user_id ?? "") !== vendorUserId) {
    const { data: offer } = await db
      .from("work_order_vendor_offers")
      .select("id")
      .eq("work_order_id", recordRef.id)
      .eq("vendor_user_id", vendorUserId)
      .eq("status", "sent")
      .maybeSingle();
    if (!offer) return null;
  }
  const row = (record.row_data ?? {}) as { propertyId?: unknown; assignedPropertyId?: unknown };
  const propertyId = String(row.propertyId ?? row.assignedPropertyId ?? "").trim();
  return { recordRef, ...(propertyId ? { propertyId } : {}) };
}

/**
 * Vendor -> PropLane user is in-app: the vendor's copy and the manager's side of
 * the SAME conversation (the resolver keys it, so no second conversation) are
 * written here, with no work identity and no provider. Both writes are idempotent
 * on `messageId`, so a retried send repairs a half-written pair and never doubles.
 */
async function deliverVendorInApp(
  db: SupabaseClient,
  actor: { userId: string; email: string; name: string },
  input: {
    recipient: Recipient;
    role: "manager" | "admin";
    target: Awaited<ReturnType<typeof resolveInboxThreadReplyTarget>>;
    subject: string;
    text: string;
    attachments: { url: string; name?: string }[];
    messageId: string;
    job: { recordRef: RecordRef; propertyId?: string } | null;
  },
): Promise<void> {
  const { recipient, target } = input;
  const when = formatInboxStamp(new Date());
  const preview = input.text.slice(0, 100).replace(/\n/g, " ");
  const common = {
    fromName: actor.name || "PropLane vendor", subject: input.subject, body: input.text, preview, when,
    messageId: input.messageId, channel: "proplane" as const, messageSubject: input.subject,
    attachments: input.attachments, delivery: "sent" as const,
    ...(input.job ? { recordRef: input.job.recordRef } : {}),
  };
  const hints = { managerUserId: recipient.userId, propertyId: input.job?.propertyId ?? null, otherPartyUserId: actor.userId };
  // The manager's side: same attachment paths on their thread are what let
  // `userCanAccessInboxAttachment` serve the file to them.
  const inboxCopy = deliverPortalMessageThreadSide(db, {
    ...common,
    scope: scopeForRole(input.role), folder: "inbox", ownerUserId: recipient.userId, participantEmail: recipient.email,
    otherPartyEmail: actor.email, fallbackId: `vendor-sponsored-inbox:${actor.userId}:${recipient.userId}`,
    unread: true, outbound: false, conversation: hints,
  });
  if (target) {
    await inboxCopy;
    await commitInboxThreadReply(db, target, {
      fromName: common.fromName, text: input.text, attachments: input.attachments, messageId: input.messageId,
      channel: "proplane", subject: input.subject, outbound: true, delivery: "sent",
      ...(input.job ? { recordRef: input.job.recordRef } : {}),
    });
    return;
  }
  await Promise.all([
    deliverPortalMessageThreadSide(db, {
      ...common,
      scope: scopeForRole("vendor"), folder: "sent", ownerUserId: actor.userId, participantEmail: null,
      otherPartyEmail: recipient.email, fallbackId: `vendor-sponsored-sent:${actor.userId}:${recipient.userId}`,
      unread: false, outbound: true, conversation: hints,
    }),
    inboxCopy,
  ]);
}

/**
 * Vendor sponsored delivery is intentionally narrow: a vendor can address an
 * existing authorized conversation or a linked manager account.  An email,
 * phone, manager id, and work-order id in a request are never destinations.
 */
export async function sendVendorSponsoredOutbound(
  db: SupabaseClient,
  actor: { userId: string; email: string; name: string },
  request: VendorSponsoredOutboundRequest,
  provider: VendorDeliveryProvider = createVendorWorkIdentityDeliveryProvider(),
): Promise<VendorSponsoredOutboundResult> {
  const subject = request.subject.trim();
  const attachments = attachmentMetaFromUrls(request.attachmentUrls ?? []);
  const attachmentNote = attachments.length
    ? `\n\nAttachments:\n${attachments.map((attachment) => `${resolveEmailLinkBaseUrl().replace(/\/$/, "")}${attachment.url}`).join("\n")}`
    : "";
  const text = `${request.text.trim()}${attachmentNote}`.trim();
  const threadId = request.threadId?.trim() || "";
  const recipientUserId = request.recipientUserId?.trim() || "";
  if (!subject || !text || !request.sendId.trim() || (!threadId && !(recipientUserId || request.recipientAdmin))) {
    return { ok: false, error: "invalid_request" };
  }

  const target = threadId
    ? await resolveInboxThreadReplyTarget(db, { threadId, senderUserId: actor.userId, senderEmail: actor.email })
    : null;
  if (threadId && !target) return { ok: false, error: "conversation_unavailable" };

  // A reply binding is written only by an inbound turn to the vendor's work
  // identity or by the vendor's own authorized external compose; a thread the
  // manager started has none.
  const binding = target
    ? await replyBindingFor(db, { vendorUserId: actor.userId, threadId, channel: request.channel })
    : null;
  // In-app first: when the other end of the thread is a PropLane account the
  // vendor is linked to, deliver into that account's inbox. Inbox row_data is
  // client-editable display data, so it can only name which LINKED account.
  const counterpart = target ? await threadCounterpartProfile(db, target, binding) : null;
  const counterpartRole = counterpart ? await inAppRoleFor(db, actor.userId, counterpart) : null;
  if (target && counterpart && !counterpartRole && !binding) return { ok: false, error: "recipient_unlinked" };
  if (target && !binding && !counterpartRole) return { ok: false, error: "conversation_unavailable" };
  if (target && counterpart && counterpartRole) {
    if (request.preflight) return { ok: true, providerMessageId: null, delivery: "sending" };
    const job = counterpart.userId ? await verifiedJobRef(db, actor.userId, counterpart.userId, request.recordRef) : null;
    await deliverVendorInApp(db, actor, {
      recipient: counterpart, role: counterpartRole, target, subject, text: request.text.trim(), attachments,
      messageId: `vendor-sponsored:${request.sendId}`, job,
    });
    return { ok: true, providerMessageId: null, delivery: "sent" };
  }

  const boundRecipient = binding?.recipient ?? "";
  const resolvedRecipient = request.recipientAdmin && !target
    // Email has historically delivered to the primary-admin mailbox even when
    // that account has no profile. SMS cannot do that: obtain the actual
    // profile phone first and fail closed if it is absent or malformed.
    ? request.channel === "sms"
      ? await profileByEmail(db, PRIMARY_ADMIN_EMAIL.trim().toLowerCase())
      : { userId: null, email: PRIMARY_ADMIN_EMAIL.trim().toLowerCase(), role: "admin", phone: null }
    : target
    ? binding?.recipient_user_id
      ? await profileById(db, binding.recipient_user_id)
      : request.channel === "email"
        ? await profileByEmail(db, boundRecipient)
        : null
    : await profileById(db, recipientUserId);
  // Inbound vendor threads may belong to an external person without a portal
  // profile. Their normalized destination is server-written thread metadata;
  // never substitute a request To field here.
  const recipient = resolvedRecipient ?? (target && request.channel === "email" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(boundRecipient)
    ? {
        userId: null,
        email: boundRecipient,
        role: "external",
        phone: null,
      }
    : target && request.channel === "sms" && normalizeE164(boundRecipient)
      ? {
          userId: null,
          // Existing SMS threads append in place and need no email. Never
          // synthesize a pseudo-address into an inbox identity.
          email: "",
          role: "external",
          phone: normalizeE164(boundRecipient),
        }
    : null);
  if (!recipient) return { ok: false, error: "recipient_unlinked" };
  const deliveryRecipient = request.channel === "email" ? recipient.email : normalizeE164(recipient.phone ?? "");
  // Resolve and validate the actual channel destination during preflight. The
  // exact same value is later passed to delivery and stored in the reply binding.
  if (!deliveryRecipient) return { ok: false, error: "recipient_unlinked" };

  // The exact directory/account-link relationship is the source of the portal
  // scope. A multi-role manager may retain a legacy profiles.role of resident.
  if (!target && !request.recipientAdmin) recipient.role = "manager";

  // A reply is addressed only from an already-authorized vendor thread.  A
  // customer who contacted a valid work identity need not also appear in the
  // manager directory; new compose remains exact-link/admin only.
  if (!target && !request.recipientAdmin && !(await vendorMayReachManager(db, actor.userId, recipient.userId!))) {
    return { ok: false, error: "recipient_unlinked" };
  }

  if (!target && !request.recipientAdmin) {
    const scoped = await filterRecipientsBySenderScope(
      db,
      { id: actor.userId, email: actor.email, role: "vendor", isAdmin: false },
      [{ userId: recipient.userId, email: recipient.email, role: recipient.role, scope: scopeForRole(recipient.role) }],
    );
    if (scoped.allowed.length !== 1) return { ok: false, error: "recipient_unlinked" };
  }

  if (request.preflight) return { ok: true, providerMessageId: null, delivery: "sending" };

  // A linked PropLane manager (or the admin's account) is reached in-app. Only
  // an admin with no profile (the historic mailbox) still goes out by email.
  if (!target && recipient.userId) {
    const job = await verifiedJobRef(db, actor.userId, recipient.userId, request.recordRef);
    await deliverVendorInApp(db, actor, {
      recipient, role: request.recipientAdmin ? "admin" : "manager", target: null, subject, text: request.text.trim(),
      attachments, messageId: `vendor-sponsored:${request.sendId}`, job,
    });
    return { ok: true, providerMessageId: null, delivery: "sent" };
  }

  const delivered = await deliverVendorWorkIdentity(
    db,
    {
      vendorUserId: actor.userId,
      channel: request.channel,
      recipient: deliveryRecipient,
      recipientUserId: binding?.recipient_user_id ?? recipient.userId ?? null,
      subject,
      text,
      idempotencyKey: request.sendId,
      contextFingerprint: `thread:${threadId || "new"}|recipient:${recipient.userId || "admin"}`,
      // This endpoint is a live vendor compose. Scheduled automation has no
      // public route here, and must call a separate server action that supplies
      // the automated class itself.
      sendClass: "transactional",
    },
    provider,
  );
  if (!delivered.ok && !delivered.authorized) return { ok: false, error: "delivery_refused", reason: delivered.reason };
  const delivery = delivered.sent ? "sent" as const : delivered.reason === "provider_outcome_unknown" ? "sending" as const : "failed" as const;
  // A text the vendor sent through their number keeps that manager's conversation "recent" for reply routing.
  if (request.channel === "sms" && delivered.sent) {
    try {
      const { data: identity } = await db.from("vendor_work_identities").select("id").eq("vendor_user_id", actor.userId).maybeSingle();
      const identityId = String((identity as { id?: unknown } | null)?.id ?? "");
      if (identityId) await touchVendorNumberConversation(db, { identityId, vendorUserId: actor.userId, counterpartPhone: deliveryRecipient, direction: "outbound" });
    } catch (error) {
      // Best effort: a missed touch only means routing falls back to the prompt, never a failed send.
      console.error("vendor number conversation touch failed", error);
    }
  }

  const messageId = `vendor-sponsored:${request.sendId}`;
  if (target) {
    const persistedDelivery = await commitInboxThreadReply(db, target, {
      fromName: actor.name || "PropLane vendor",
      text,
      attachments,
      messageId,
      channel: request.channel,
      subject,
      outbound: true,
      delivery,
    });
    return {
      ok: true,
      providerMessageId: delivered.providerMessageId ?? null,
      delivery: persistedDelivery ?? delivery,
    };
  } else {
    const when = formatInboxStamp(new Date());
    const preview = text.slice(0, 100).replace(/\n/g, " ");
    const [sentCopy, inboxCopy] = await Promise.all([
      deliverPortalMessageThreadSide(db, {
        scope: scopeForRole("vendor"), folder: "sent", ownerUserId: actor.userId, participantEmail: null,
        otherPartyEmail: recipient.email, fallbackId: `vendor-sponsored-sent:${actor.userId}:${recipient.userId}`,
        fromName: actor.name || "PropLane vendor", subject, body: text, preview, when, unread: false, outbound: true,
        messageId, channel: request.channel, messageSubject: subject, attachments, delivery,
      }),
      deliverPortalMessageThreadSide(db, {
        scope: scopeForRole(recipient.role), folder: "inbox", ownerUserId: recipient.userId || null, participantEmail: recipient.email,
        otherPartyEmail: actor.email, fallbackId: `vendor-sponsored-inbox:${actor.userId}:${recipient.userId}`,
        fromName: actor.name || "PropLane vendor", subject, body: text, preview, when, unread: true, outbound: false,
        messageId, channel: request.channel, messageSubject: subject, attachments, delivery,
      }),
    ]);
    // Bind the vendor's own sent copy after a server-authorized new compose.
    // A future reply refuses closed if this write cannot be made.
    await bindVendorReplyTarget(db, {
      vendorUserId: actor.userId,
      threadId: sentCopy.threadId,
      channel: request.channel,
      recipient: deliveryRecipient,
      recipientUserId: recipient.userId,
      messageId,
    });
    return {
      ok: true,
      providerMessageId: delivered.providerMessageId ?? null,
      delivery: aggregateVendorSponsoredDelivery(
        [sentCopy.delivery ?? delivery, inboxCopy.delivery ?? delivery],
      ),
    };
  }
}
