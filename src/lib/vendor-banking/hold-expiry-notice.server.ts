import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { deliverPortalInboxMessage } from "@/lib/portal-inbox-delivery";
import { directInvoiceIdFromHoldSourceId } from "@/lib/stripe-platform-hold";

export const HOLD_EXPIRY_DAYS = 90;

type HoldIdentity = { id: string; ownerUserId: string; sourceId: string; amountCents: number };

/** Resolves the manager who paid + a human label, trying the work order first then the invoice — the hold's sourceId is one or the other. */
export async function resolvePayerForHold(
  db: SupabaseClient,
  hold: Pick<HoldIdentity, "sourceId">,
): Promise<{ managerUserId: string | null; label: string }> {
  const { data: wo } = await db
    .from("portal_work_order_records")
    .select("manager_user_id, row_data")
    .eq("id", directInvoiceIdFromHoldSourceId(hold.sourceId) ?? hold.sourceId)
    .maybeSingle();
  if (wo) {
    const rowData = (wo as { row_data?: { title?: string } }).row_data;
    return { managerUserId: String((wo as { manager_user_id: string }).manager_user_id), label: rowData?.title || "a service" };
  }
  const { data: inv } = await db
    .from("vendor_invoices")
    .select("manager_user_id, invoice_number")
    .eq("id", directInvoiceIdFromHoldSourceId(hold.sourceId) ?? hold.sourceId)
    .maybeSingle();
  if (inv) {
    const row = inv as { manager_user_id: string; invoice_number: string | null };
    return { managerUserId: row.manager_user_id, label: row.invoice_number ? `invoice ${row.invoice_number}` : "an invoice" };
  }
  return { managerUserId: null, label: "a service" };
}

async function lookupEmail(db: SupabaseClient, userId: string): Promise<string | null> {
  const { data } = await db.from("profiles").select("email").eq("id", userId).maybeSingle();
  const email = (data as { email?: string | null } | null)?.email?.trim();
  return email ? email.toLowerCase() : null;
}

/**
 * Best-effort "returned unclaimed" notices to both parties (item 3: "ledger + notification to
 * both"), self-notify pattern (sender == recipient, fromName "PropLane") matching
 * send-document-expiration-reminders. `messageId` is deterministic per hold + audience, so the
 * cron re-running, a replayed refund or the webhook that settles a pending one appends each
 * notice at most once.
 */
export async function notifyHoldReturned(
  db: SupabaseClient,
  hold: Pick<HoldIdentity, "id" | "ownerUserId">,
  managerUserId: string | null,
  label: string,
  amountCents: number,
): Promise<void> {
  const amountLabel = `$${(amountCents / 100).toFixed(2)}`;
  if (managerUserId) {
    const managerEmail = await lookupEmail(db, managerUserId);
    if (managerEmail) {
      await deliverPortalInboxMessage(db, {
        senderUserId: managerUserId,
        senderEmail: managerEmail,
        fromName: "PropLane",
        senderRole: "manager",
        subject: "A held vendor payment was returned to you",
        text: `A payment of ${amountLabel} for ${label} was held on PropLane while the vendor finished setting up their bank. It went unclaimed for ${HOLD_EXPIRY_DAYS} days, so it has been refunded back to you.`,
        toUserIds: [managerUserId],
        messageId: `hold-expiry:${hold.id}:manager`,
      }).catch(() => undefined);
    }
  }
  const vendorEmail = await lookupEmail(db, hold.ownerUserId);
  if (vendorEmail) {
    await deliverPortalInboxMessage(db, {
      senderUserId: hold.ownerUserId,
      senderEmail: vendorEmail,
      fromName: "PropLane",
      senderRole: "vendor",
      subject: "A held payment was returned to the manager",
      text: `A payment of ${amountLabel} for ${label} was held on PropLane for ${HOLD_EXPIRY_DAYS} days waiting on your bank details. It has been returned to the manager. Add your bank in Settings to receive future payments right away.`,
      toUserIds: [hold.ownerUserId],
      messageId: `hold-expiry:${hold.id}:vendor`,
    }).catch(() => undefined);
  }
}

/**
 * The same notice, from the settlement half: a hold-expiry refund that came back `pending` is
 * announced by whoever sees it reach `succeeded` — the next cron pass or the Stripe webhook.
 * Deterministic message ids mean both running is one notice per audience.
 */
export async function notifyHoldReturnedByHoldId(
  db: SupabaseClient,
  input: { holdId: string; amountCents: number },
): Promise<void> {
  const { data } = await db
    .from("platform_payment_holds")
    .select("id, owner_user_id, source_id")
    .eq("id", input.holdId)
    .maybeSingle();
  const row = data as { id: string; owner_user_id: string; source_id: string } | null;
  if (!row) return;
  const hold = { id: String(row.id), ownerUserId: String(row.owner_user_id), sourceId: String(row.source_id) };
  const { managerUserId, label } = await resolvePayerForHold(db, hold);
  await notifyHoldReturned(db, hold, managerUserId, label, input.amountCents);
}
