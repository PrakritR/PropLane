/**
 * Delivers a vendor-facing notification: email, an audit-log row, and an Axis
 * inbox message once the vendor has a linked auth user. Shared by every vendor
 * notification path (visit scheduled, bid offer request) so there is one place
 * that does the send + audit log + inbox delivery, rather than duplicating it
 * per route.
 *
 * PLAN-0915 area 4: this now routes through `deliverPortalInboxMessage`'s
 * `eventCategory` + `vendorTopic` gate — the SAME per-recipient channel
 * resolution (`resolveChannels` → `resolveVendorChannels`) every reminder
 * already uses for a vendor recipient — instead of a raw, unconditional Resend
 * call. Before this fix, a vendor's own Settings → Notifications topic
 * on/off, quiet hours, and phone opt-out were only honored for a REMINDER's
 * vendor copy; this ad hoc send (a visit notice, a bid offer) bypassed every
 * one of them and never texted at all.
 */
import { deliverPortalInboxMessage } from "@/lib/portal-inbox-delivery";
import { shouldSkipOutboundEmail } from "@/lib/portal-sandbox-accounts";
import type { VendorNotificationTopic } from "@/lib/vendor-notification-settings";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;

export type VendorNotificationActor = { userId: string; email: string; fullName: string };

export type VendorNotificationParams = {
  vendorEmail: string;
  /** manager_vendor_records id, used to resolve the vendor's linked auth user for inbox delivery. */
  vendorDirectoryId?: string | null;
  vendorUserId?: string | null;
  subject: string;
  body: string;
  /**
   * Which vendor Settings → Notifications row gates this send. Defaults to
   * "schedule" — a visit notice or reminder; pass "offers" for a bid/offer
   * request so it is gated by the same row the offer's own reminder uses.
   */
  topic?: VendorNotificationTopic;
  /** An emergency work order: the vendor's own quiet-hours bypass applies, when they opted in. */
  urgent?: boolean;
};

export async function sendVendorNotification(
  db: Db,
  actor: VendorNotificationActor,
  params: VendorNotificationParams,
): Promise<{ emailSent: boolean; inboxDelivered: boolean; skippedDemoEmail: boolean }> {
  const vendorEmail = params.vendorEmail.trim().toLowerCase();
  const skippedDemoEmail = shouldSkipOutboundEmail(vendorEmail);

  let vendorUserId = params.vendorUserId ?? null;
  if (!vendorUserId && params.vendorDirectoryId) {
    const { data: vendorRow } = await db
      .from("manager_vendor_records")
      .select("vendor_user_id")
      .eq("id", params.vendorDirectoryId)
      .maybeSingle();
    vendorUserId = (vendorRow?.vendor_user_id as string | null) ?? null;
  }

  const delivery = await deliverPortalInboxMessage(db, {
    senderUserId: actor.userId,
    senderEmail: actor.email,
    fromName: actor.fullName || "PropLane Portal",
    subject: params.subject,
    text: params.body,
    ...(vendorUserId ? { toUserIds: [vendorUserId] } : { toEmails: [vendorEmail] }),
    deliverViaEmail: true,
    deliverViaSms: true,
    eventCategory: "maintenance",
    vendorTopic: params.topic ?? "schedule",
    urgent: params.urgent,
  });

  if (!delivery.ok) return { emailSent: false, inboxDelivered: false, skippedDemoEmail };
  const emailSent = delivery.emailOutcomes.some((outcome) => outcome.status === "submitted");
  return { emailSent, inboxDelivered: Boolean(vendorUserId), skippedDemoEmail };
}
