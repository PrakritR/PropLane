import "server-only";

/**
 * The resident-inbox half of "we received your application" for an application made in the portal / website
 * (`notice-channel.ts`): an inbox message from the workspace owner, never a text and not a second email (the
 * submit route sends its own confirmation email with the sign-in link). The recipient is the login the stored
 * application row is stamped with, so a request body never names who is messaged. The message id is stable per
 * application, so a retry or a resend appends at most one.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { residentPortalUrl } from "@/lib/claw-resident-links";
import { deliverPortalInboxMessage } from "@/lib/portal-inbox-delivery";
import { loadOwnerIdentity } from "@/lib/short-stay/stay-labels.server";

export function applicationSubmittedPortalNotice(propertyTitle: string): { subject: string; text: string } {
  const at = propertyTitle.trim() ? ` for ${propertyTitle.trim()}` : "";
  return {
    subject: "Application received",
    text: `We received your application${at}. Your property manager will review it and you will hear back here. See it in Applications: ${residentPortalUrl("applications")}`,
  };
}

export async function deliverApplicationSubmittedPortalNotice(
  db: SupabaseClient,
  input: { managerUserId: string; applicationId: string; residentUserId: string; propertyTitle: string },
): Promise<{ ok: true } | { ok: false; reason: "no_resident" | "no_owner" | "delivery_failed" }> {
  const residentUserId = input.residentUserId.trim();
  if (!residentUserId) return { ok: false, reason: "no_resident" };
  const owner = await loadOwnerIdentity(db, input.managerUserId);
  if (!owner.email) return { ok: false, reason: "no_owner" };
  const notice = applicationSubmittedPortalNotice(input.propertyTitle);
  const result = await deliverPortalInboxMessage(db, {
    senderUserId: input.managerUserId,
    senderEmail: owner.email,
    fromName: owner.name || "PropLane",
    subject: notice.subject,
    text: notice.text,
    toUserIds: [residentUserId],
    deliverToPortalInbox: true,
    deliverViaEmail: false,
    deliverViaSms: false,
    suppressSms: true,
    automated: true,
    messageId: `application:submitted:${input.applicationId}`,
    ownerManagerUserId: input.managerUserId,
    propertyId: null,
    recipientsAuthorizedByCaller: true,
  }).catch(() => ({ ok: false as const, error: "Delivery failed" }));
  return result.ok ? { ok: true } : { ok: false, reason: "delivery_failed" };
}
