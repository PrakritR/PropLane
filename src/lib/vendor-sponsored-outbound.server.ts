import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { filterRecipientsBySenderScope } from "@/lib/inbox-recipient-scope";
import { PRIMARY_ADMIN_EMAIL } from "@/lib/auth/primary-admin";
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

type Recipient = { userId: string; email: string; role: string };

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
};

export type VendorSponsoredOutboundResult =
  | { ok: true; providerMessageId: string | null }
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
  const text = request.text.trim();
  const threadId = request.threadId?.trim() || "";
  const recipientUserId = request.recipientUserId?.trim() || "";
  if (!subject || !text || !request.sendId.trim() || (threadId ? Boolean(recipientUserId || request.recipientAdmin) : !(recipientUserId || request.recipientAdmin))) {
    return { ok: false, error: "invalid_request" };
  }

  const target = threadId
    ? await resolveInboxThreadReplyTarget(db, { threadId, senderUserId: actor.userId, senderEmail: actor.email })
    : null;
  if (threadId && !target) return { ok: false, error: "conversation_unavailable" };

  // Conversation rows persist the other party under row_data.email.  Treat an
  // absent value as a refusal rather than falling back to a client-supplied To.
  const threadEmail = target ? String(target.rowData.email ?? "").trim().toLowerCase() : "";
  const recipient = request.recipientAdmin && !target
    ? { userId: "", email: PRIMARY_ADMIN_EMAIL.trim().toLowerCase(), role: "admin" }
    : target
    ? await profileByEmail(db, threadEmail)
    : await profileById(db, recipientUserId);
  if (!recipient) return { ok: false, error: "recipient_unlinked" };

  // A reply is addressed only from an already-authorized vendor thread.  A
  // customer who contacted a valid work identity need not also appear in the
  // manager directory; new compose remains exact-link/admin only.
  if (!target && !request.recipientAdmin && !(await vendorMayReachManager(db, actor.userId, recipient.userId))) {
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

  const delivered = await deliverVendorWorkIdentity(
    db,
    {
      vendorUserId: actor.userId,
      channel: request.channel,
      recipient: request.channel === "email" ? recipient.email : String((await db.from("profiles").select("phone").eq("id", recipient.userId).maybeSingle()).data?.phone ?? ""),
      recipientUserId: recipient.userId || null,
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
  if (!delivered.ok || !delivered.sent) return { ok: false, error: "delivery_refused", reason: delivered.reason };

  const messageId = `vendor-sponsored:${request.channel}:${request.sendId}`;
  if (target) {
    await commitInboxThreadReply(db, target, {
      fromName: actor.name || "PropLane vendor",
      text,
      messageId,
      channel: request.channel,
      subject,
      outbound: true,
    });
  } else {
    const when = new Intl.DateTimeFormat("en-US", { dateStyle: "short", timeStyle: "short", timeZone: "America/Los_Angeles" }).format(new Date());
    const preview = text.slice(0, 100).replace(/\n/g, " ");
    await Promise.all([
      deliverPortalMessageThreadSide(db, {
        scope: scopeForRole("vendor"), folder: "sent", ownerUserId: actor.userId, participantEmail: null,
        otherPartyEmail: recipient.email, fallbackId: `vendor-sponsored-sent:${actor.userId}:${recipient.userId}`,
        fromName: actor.name || "PropLane vendor", subject, body: text, preview, when, unread: false, outbound: true,
        messageId, channel: request.channel, messageSubject: subject,
      }),
      deliverPortalMessageThreadSide(db, {
        scope: scopeForRole(recipient.role), folder: "inbox", ownerUserId: recipient.userId || null, participantEmail: recipient.email,
        otherPartyEmail: actor.email, fallbackId: `vendor-sponsored-inbox:${actor.userId}:${recipient.userId}`,
        fromName: actor.name || "PropLane vendor", subject, body: text, preview, when, unread: true, outbound: false,
        messageId, channel: request.channel, messageSubject: subject,
      }),
    ]);
  }
  return { ok: true, providerMessageId: delivered.providerMessageId ?? null };
}
