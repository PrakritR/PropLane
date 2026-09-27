import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import { refundPlatformHold, type PlatformHoldRow } from "@/lib/stripe-platform-hold.server";
import { recordVendorBankingLedgerEntry } from "@/lib/vendor-banking/ledger.server";
import { deliverPortalInboxMessage } from "@/lib/portal-inbox-delivery";

export const HOLD_EXPIRY_DAYS = 90;

/** Every `held` vendor_invoice-sourced hold older than the cutoff — VD58's 90-day cap. */
export async function listExpiredVendorHolds(db: SupabaseClient, now: Date = new Date()): Promise<PlatformHoldRow[]> {
  const cutoffIso = new Date(now.getTime() - HOLD_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await db
    .from("platform_payment_holds")
    .select("id, owner_user_id, owner_role, source, source_id, amount_cents, status, stripe_charge_id, stripe_transfer_id, created_at")
    .eq("source", "vendor_invoice")
    .eq("status", "held")
    .lt("created_at", cutoffIso);
  if (error) throw new Error(`Could not list expired vendor holds: ${error.message}`);
  return (data ?? []).map((row) => ({
    id: String(row.id),
    ownerUserId: String(row.owner_user_id),
    ownerRole: row.owner_role,
    source: row.source,
    sourceId: String(row.source_id),
    amountCents: Number(row.amount_cents) || 0,
    status: row.status,
    stripeChargeId: row.stripe_charge_id,
    stripeTransferId: row.stripe_transfer_id,
    createdAt: row.created_at,
  })) as PlatformHoldRow[];
}

/** Resolves the manager who paid + a human label, trying the work order first then the invoice — the hold's sourceId is one or the other. */
async function resolvePayerForHold(
  db: SupabaseClient,
  hold: PlatformHoldRow,
): Promise<{ managerUserId: string | null; label: string }> {
  const { data: wo } = await db
    .from("portal_work_order_records")
    .select("manager_user_id, row_data")
    .eq("id", hold.sourceId)
    .maybeSingle();
  if (wo) {
    const rowData = (wo as { row_data?: { title?: string } }).row_data;
    return { managerUserId: String((wo as { manager_user_id: string }).manager_user_id), label: rowData?.title || "a service" };
  }
  const { data: inv } = await db
    .from("vendor_invoices")
    .select("manager_user_id, invoice_number")
    .eq("id", hold.sourceId)
    .maybeSingle();
  if (inv) {
    const row = inv as { manager_user_id: string; invoice_number: string | null };
    return { managerUserId: row.manager_user_id, label: row.invoice_number ? `invoice ${row.invoice_number}` : "an invoice" };
  }
  return { managerUserId: null, label: "a service" };
}

/** Reads back the EXACT gross charge + fee amounts this vendor's ledger already recorded for this source id — never re-derived, so the reversal matches what actually happened to the cent. */
async function readOriginalChargeAndFee(
  db: SupabaseClient,
  vendorUserId: string,
  sourceId: string,
): Promise<{ grossCents: number; feeCents: number }> {
  const { data, error } = await db
    .from("vendor_banking_ledger_entries")
    .select("kind, amount_cents")
    .eq("vendor_user_id", vendorUserId)
    .eq("source_id", sourceId)
    .in("kind", ["charge", "platform_fee"]);
  if (error) return { grossCents: 0, feeCents: 0 };
  let grossCents = 0;
  let feeCents = 0;
  for (const row of (data ?? []) as Array<{ kind: string; amount_cents: number }>) {
    if (row.kind === "charge") grossCents += Number(row.amount_cents) || 0;
    if (row.kind === "platform_fee") feeCents += Math.abs(Number(row.amount_cents) || 0);
  }
  return { grossCents, feeCents };
}

async function lookupEmail(db: SupabaseClient, userId: string): Promise<string | null> {
  const { data } = await db.from("profiles").select("email").eq("id", userId).maybeSingle();
  const email = (data as { email?: string | null } | null)?.email?.trim();
  return email ? email.toLowerCase() : null;
}

export type HoldExpiryResult = {
  checked: number;
  returned: number;
  failed: number;
  errors: string[];
};

/**
 * The scheduled 90-day hold-expiry job (VD58, captain's recommended option):
 * a vendor_invoice-sourced hold still unclaimed after 90 days is returned to
 * the manager who paid it — a full refund of the original Stripe charge
 * (never a partial guess) — and the hold is marked `refunded`. Reverses the
 * earlier charge/fee ledger lines so the vendor's statement nets back to
 * zero for a payment they never actually received. Best-effort per hold: one
 * failure never blocks the rest.
 */
export async function expireVendorHolds(stripe: Stripe, db: SupabaseClient, now: Date = new Date()): Promise<HoldExpiryResult> {
  const holds = await listExpiredVendorHolds(db, now);
  const result: HoldExpiryResult = { checked: holds.length, returned: 0, failed: 0, errors: [] };

  for (const hold of holds) {
    try {
      if (!hold.stripeChargeId) {
        result.failed += 1;
        result.errors.push(`hold ${hold.id}: no stripe_charge_id on file, cannot refund`);
        continue;
      }
      await stripe.refunds.create(
        { charge: hold.stripeChargeId, reason: "requested_by_customer" },
        { idempotencyKey: `hold-expiry:${hold.id}` },
      );
      await refundPlatformHold(db, hold.source, hold.sourceId);

      const { managerUserId, label } = await resolvePayerForHold(db, hold);

      // Reverse the earlier charge (gross credit) and platform_fee (debit)
      // by their EXACT original amounts (read back, never re-derived) so the
      // statement nets to zero for a payment the vendor never actually
      // received — the whole point of "return to the manager", including
      // PropLane's own fee.
      const { grossCents, feeCents } = await readOriginalChargeAndFee(db, hold.ownerUserId, hold.sourceId);
      await recordVendorBankingLedgerEntry(db, {
        vendorUserId: hold.ownerUserId,
        managerUserId,
        kind: "refund",
        amountCents: -(grossCents || hold.amountCents),
        source: "hold_expiry",
        sourceId: hold.sourceId,
        description: `Returned to the manager — unclaimed after ${HOLD_EXPIRY_DAYS} days`,
        stripeObjectId: hold.stripeChargeId,
        idempotencyKey: `hold_expiry:${hold.id}:refund`,
      });
      if (feeCents > 0) {
        await recordVendorBankingLedgerEntry(db, {
          vendorUserId: hold.ownerUserId,
          managerUserId,
          kind: "adjustment",
          amountCents: feeCents, // gives back PropLane's own fee on a payment that was never actually delivered
          source: "hold_expiry",
          sourceId: hold.sourceId,
          description: "PropLane fee reversed — payment returned unclaimed",
          stripeObjectId: hold.stripeChargeId,
          idempotencyKey: `hold_expiry:${hold.id}:fee_reversal`,
        });
      }

      result.returned += 1;

      // Best-effort notification to both parties (item 3: "ledger +
      // notification to both") — self-notify pattern (sender == recipient,
      // fromName "PropLane") matching send-document-expiration-reminders.
      const amountLabel = `$${(hold.amountCents / 100).toFixed(2)}`;
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
        }).catch(() => undefined);
      }
    } catch (e) {
      result.failed += 1;
      const message = e instanceof Error ? e.message : String(e);
      result.errors.push(`hold ${hold.id}: ${message}`);
      console.error(`[vendor-banking] hold expiry failed for ${hold.id}:`, message);
    }
  }
  return result;
}
