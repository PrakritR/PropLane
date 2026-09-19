/**
 * Delivers a vendor-facing notification: best-effort email via Resend (skipped
 * for @axis.local demo addresses), an audit-log row, and an Axis inbox message
 * once the vendor has a linked auth user. Shared by every vendor notification
 * path (visit scheduled, bid offer request) so there is one place that does the
 * Resend call + audit log + inbox delivery, rather than duplicating it per route.
 */
import { deliverPortalInboxMessage } from "@/lib/portal-inbox-delivery";
import { managerOutboundFromHeader } from "@/lib/manager-outbound-identity.server";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { postResendEmail } from "@/lib/resend-delivery.server";

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;

export type VendorNotificationActor = { userId: string; email: string; fullName: string };

export type VendorNotificationParams = {
  vendorEmail: string;
  /** manager_vendor_records id, used to resolve the vendor's linked auth user for inbox delivery. */
  vendorDirectoryId?: string | null;
  vendorUserId?: string | null;
  subject: string;
  body: string;
};

export async function sendVendorNotification(
  db: Db,
  actor: VendorNotificationActor,
  params: VendorNotificationParams,
): Promise<{ emailSent: boolean; inboxDelivered: boolean; skippedDemoEmail: boolean }> {
  const vendorEmail = params.vendorEmail.trim().toLowerCase();
  const skippedDemoEmail = vendorEmail.endsWith("@axis.local");

  let emailSent = false;
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (vendorEmail.includes("@") && !skippedDemoEmail && apiKey) {
    const from = await managerOutboundFromHeader(db, actor.userId);
    const html = `<p style="white-space:pre-wrap;font-family:sans-serif;font-size:15px;line-height:1.6;color:#1e293b">${params.body
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")}</p><hr style="margin:24px 0;border:none;border-top:1px solid #e2e8f0"><p style="font-family:sans-serif;font-size:12px;color:#94a3b8">Sent via PropLane portal</p>`;
    const res = await postResendEmail({
      apiKey,
      payload: { from, to: [vendorEmail], subject: params.subject, text: params.body, html },
      effectSummary: `Vendor notification email to ${vendorEmail} was captured for SMS test mode.`,
      metadata: { vendorDirectoryId: params.vendorDirectoryId ?? null },
    });
    emailSent = res.ok;
  }

  const outboundId = `outbound_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const { error: auditError } = await db.from("portal_outbound_mail_records").upsert(
    {
      id: outboundId,
      recipient_email: vendorEmail,
      subject: params.subject,
      channel: "email",
      row_data: {
        id: outboundId,
        to: vendorEmail,
        subject: params.subject,
        body: params.body,
        sentAt: new Date().toISOString(),
        emailSent,
      },
    },
    { onConflict: "id" },
  );
  if (auditError) {
    console.error("sendVendorNotification: audit log write failed", auditError);
  }

  let vendorUserId = params.vendorUserId ?? null;
  if (!vendorUserId && params.vendorDirectoryId) {
    const { data: vendorRow } = await db
      .from("manager_vendor_records")
      .select("vendor_user_id")
      .eq("id", params.vendorDirectoryId)
      .maybeSingle();
    vendorUserId = (vendorRow?.vendor_user_id as string | null) ?? null;
  }

  let inboxDelivered = false;
  if (vendorUserId) {
    const delivery = await deliverPortalInboxMessage(db, {
      senderUserId: actor.userId,
      senderEmail: actor.email,
      fromName: actor.fullName || "PropLane Portal",
      subject: params.subject,
      text: params.body,
      toUserIds: [vendorUserId],
      deliverToPortalInbox: true,
      deliverViaEmail: false,
      deliverViaSms: false,
    });
    inboxDelivered = delivery.ok;
  }

  return { emailSent, inboxDelivered, skippedDemoEmail };
}
