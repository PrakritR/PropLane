import "server-only";

/**
 * The portal half of a guest's outcome notices (`notice-channel.ts` decides which half runs).
 *
 * A stay made in the resident portal is answered by EMAIL and in the resident's PORTAL INBOX, from the
 * workspace owner, and never by text: `deliverViaSms: false` and `suppressSms: true`, so no preference,
 * quiet-hours deferral or retry can turn this into a text. The recipient is the login the stay row is
 * stamped with (`residentUserId`, set from the session when the row was written), which is why
 * `recipientsAuthorizedByCaller` is safe here: the id never came from a request body. The message id is
 * stable per event + stay, so a replayed cron or a double click appends at most one.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { deliverPortalInboxMessage } from "@/lib/portal-inbox-delivery";
import { isPlaceholderImportEmail } from "@/lib/portfolio-import/placeholder-email";
import { loadOwnerIdentity } from "@/lib/short-stay/stay-labels.server";
import type { PortalNotice } from "@/lib/short-stay/notice-channel";

export type GuestPortalNoticeResult = { ok: true } | { ok: false; reason: "no_guest" | "no_owner" | "delivery_failed" };

export async function deliverGuestPortalNotice(
  db: SupabaseClient,
  input: {
    ownerId: string;
    propertyId: string;
    blockId: string;
    /** `short_stay_requested|confirmed|approved|declined|expired|unpaid_expired`: the idempotency key's event part. */
    event: string;
    row: Record<string, unknown>;
    notice: PortalNotice;
  },
): Promise<GuestPortalNoticeResult> {
  const residentUserId = typeof input.row.residentUserId === "string" ? input.row.residentUserId.trim() : "";
  const typedEmail = typeof input.row.residentEmail === "string" ? input.row.residentEmail.trim().toLowerCase() : "";
  // No login means nowhere in the portal to put it; an address alone is not an identity (see guest-login.server.ts).
  if (!residentUserId) return { ok: false, reason: "no_guest" };
  const owner = await loadOwnerIdentity(db, input.ownerId);
  if (!owner.email) return { ok: false, reason: "no_owner" };
  const result = await deliverPortalInboxMessage(db, {
    senderUserId: input.ownerId,
    senderEmail: owner.email,
    fromName: owner.name || "PropLane",
    subject: input.notice.subject,
    text: input.notice.text,
    toUserIds: [residentUserId],
    deliverToPortalInbox: true,
    deliverViaEmail: Boolean(typedEmail) && !isPlaceholderImportEmail(typedEmail),
    deliverViaSms: false,
    suppressSms: true,
    automated: true,
    messageId: `short-stay:${input.event}:${input.blockId}`,
    ownerManagerUserId: input.ownerId,
    propertyId: input.propertyId || null,
    recipientsAuthorizedByCaller: true,
  }).catch(() => ({ ok: false as const, error: "Delivery failed" }));
  return result.ok ? { ok: true } : { ok: false, reason: "delivery_failed" };
}
