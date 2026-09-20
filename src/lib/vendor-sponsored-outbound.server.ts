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
  /** Authorization/target resolution only; never creates an outbox or calls a provider. */
  preflight?: boolean;
};

export type VendorSponsoredOutboundResult =
  | { ok: true; providerMessageId: string | null; delivery: "sending" | "failed" | "sent" }
  | { ok: false; error: "invalid_request" | "recipient_unlinked" | "conversation_unavailable" | "delivery_refused"; reason?: string };

async function profileById(db: SupabaseClient, id: string): Promise<Recipient | null> {
  const { data } = await db.from("profiles").select("id,email,role").eq("id", id).maybeSingle();
  const email = String(data?.email ?? "").trim().toLowerCase();
  const userId = String(data?.id ?? "").trim();
  return userId && email ? { userId, email, role: String(data?.role ?? "").trim().toLowerCase() } : null;
}

async function profileByEmail(db: SupabaseClient, email: string): Promise<Recipient | null> {
  const { data } = await db.from("profiles").select("id,email,role").eq("email", email).maybeSingle();
  const resolved = String(data?.email ?? "").trim().toLowerCase();
  const userId = String(data?.id ?? "").trim();
  return userId && resolved ? { userId, email: resolved, role: String(data?.role ?? "").trim().toLowerCase() } : null;
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
  const { data: coManagerRows } = await db
    .from("account_link_invites")
    .select("invitee_user_id")
    .eq("status", "accepted")
    .in("inviter_user_id", ownerIds)
    .eq("invitee_user_id", recipientUserId);
  return (coManagerRows ?? []).some((row) => String(row.invitee_user_id ?? "").trim() === recipientUserId);
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

  // Inbox row_data is client-editable display data. Existing-thread delivery
  // uses only the durable service-role binding created by an inbound turn or a
  // previously authorized compose, even if row_data happens to name a profile.
  const binding = target
    ? await replyBindingFor(db, { vendorUserId: actor.userId, threadId, channel: request.channel })
    : null;
  if (target && !binding) return { ok: false, error: "conversation_unavailable" };
  const boundRecipient = binding?.recipient ?? "";
  const resolvedRecipient = request.recipientAdmin && !target
    ? { userId: "", email: PRIMARY_ADMIN_EMAIL.trim().toLowerCase(), role: "admin" }
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

  const delivered = await deliverVendorWorkIdentity(
    db,
    {
      vendorUserId: actor.userId,
      channel: request.channel,
      recipient: request.channel === "email"
        ? recipient.email
        : recipient.phone ?? String((await db.from("profiles").select("phone").eq("id", recipient.userId ?? "").maybeSingle()).data?.phone ?? ""),
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
      recipient: request.channel === "email" ? recipient.email : String(recipient.phone ?? ""),
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
