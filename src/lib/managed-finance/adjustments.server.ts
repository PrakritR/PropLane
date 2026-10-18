import "server-only";

import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { alertManagerOfOwnerEvent } from "@/lib/owner-management/alerts.server";
import { LedgerError } from "@/lib/managed-finance/ledger.server";

/**
 * Refunds and disputes against a PropLane-managed workspace's captured rent. Both reverse the owner / fee split in the party
 * ledger exactly once (keyed on the Stripe refund or dispute id), and both are no-ops for a charge that was never allocated
 * there (self-serve workspaces), so they are safe to call from the shared webhook handlers.
 */

type Alloc = { id: string; charge_id: string; workspace_id: string; stripe_charge_id: string | null; principal_cents: number; refunded_principal_cents: number };

export async function managedAllocationsForStripeCharge(db: SupabaseClient, stripeChargeId: string): Promise<Alloc[]> {
  const { data, error } = await db
    .from("managed_rent_allocations")
    .select("id, charge_id, workspace_id, stripe_charge_id, principal_cents, refunded_principal_cents")
    .eq("stripe_charge_id", stripeChargeId)
    .limit(50);
  if (error) {
    if (String(error.code) === "42P01" || String(error.code) === "PGRST205") return [];
    throw new LedgerError(500, "Could not read managed allocations.");
  }
  // Only rows that really are this Charge's allocations count; anything else is not a managed payment.
  return ((data ?? []) as Alloc[]).filter((a) =>
    a && a.stripe_charge_id === stripeChargeId && typeof a.id === "string" && typeof a.charge_id === "string" &&
    Number.isSafeInteger(a.principal_cents) && Number.isSafeInteger(a.refunded_principal_cents));
}

/** The allocation a refund belongs to: the household charge named in its metadata, else the only one on the Charge. */
export function pickRefundAllocation(allocs: Alloc[], metadataChargeId: string | null | undefined): Alloc | null {
  if (allocs.length === 0) return null;
  const named = metadataChargeId?.trim();
  if (named) return allocs.find((a) => a.charge_id === named) ?? null;
  return allocs.length === 1 ? allocs[0]! : null;
}

/**
 * Reverse a SUCCEEDED refund in the party ledger. Returns false when the Charge was never allocated to a managed workspace.
 * Throws when it was but the refund cannot be matched to exactly one allocation (the delivery is retried and filed).
 */
export async function applyManagedRefund(db: SupabaseClient, refund: Stripe.Refund, stripeChargeId: string): Promise<boolean> {
  const allocs = await managedAllocationsForStripeCharge(db, stripeChargeId);
  if (allocs.length === 0) return false;
  if (refund.status !== "succeeded") return true;
  const alloc = pickRefundAllocation(allocs, refund.metadata?.proplane_charge_id);
  if (!alloc) throw new LedgerError(409, "A refund on a managed payment names no single charge; it needs review.");
  const { data, error } = await db.rpc("apply_managed_refund", {
    p_alloc: alloc.id,
    p_refund: refund.id,
    p_amount: refund.amount,
    p_posted: new Date((refund.created ?? Date.now() / 1000) * 1000).toISOString(),
  });
  const result = data as { status?: string; reason?: string } | null;
  if (error || !result || (result.status !== "created" && result.status !== "exists")) {
    throw new LedgerError(409, `A managed refund could not be applied (${result?.reason ?? error?.message ?? "refused"}).`);
  }
  return true;
}

export type DisputePhase = "opened" | "won" | "lost";

export function disputePhase(status: string): DisputePhase {
  if (status === "lost") return "lost";
  if (status === "won" || status === "warning_closed" || status === "charge_refunded") return "won";
  return "opened";
}

const DEFAULT_DISPUTE_FEE_CENTS = 1500;

function disputeFeeCents(dispute: Stripe.Dispute): number {
  const txns = (dispute.balance_transactions ?? []) as Array<Stripe.BalanceTransaction | string>;
  const fees = txns.reduce((sum, t) => sum + (typeof t === "object" && Number.isSafeInteger(t.fee) ? t.fee : 0), 0);
  return fees > 0 ? fees : DEFAULT_DISPUTE_FEE_CENTS;
}

/** Freeze / release / write off the owner's share of a disputed managed payment. False when the PaymentIntent was never allocated. */
export async function applyManagedDispute(db: SupabaseClient, dispute: Stripe.Dispute): Promise<boolean> {
  const piId = typeof dispute.payment_intent === "string" ? dispute.payment_intent : dispute.payment_intent?.id;
  if (!piId) return false;
  const { data: probe, error: probeError } = await db.from("managed_rent_allocations").select("id, workspace_id").eq("stripe_payment_intent_id", piId).limit(1);
  if (probeError) {
    if (String(probeError.code) === "42P01" || String(probeError.code) === "PGRST205") return false;
    throw new LedgerError(500, "Could not read managed allocations.");
  }
  if (!probe?.length) return false;
  const workspaceId = String((probe[0] as { workspace_id: string }).workspace_id);
  const phase = disputePhase(dispute.status);

  const call = async (p: DisputePhase) => {
    const { data, error } = await db.rpc("apply_managed_dispute", {
      p_pi: piId, p_dispute: dispute.id, p_phase: p, p_amount: dispute.amount, p_dispute_fee: p === "lost" ? disputeFeeCents(dispute) : 0,
    });
    const result = data as { status?: string; reason?: string } | null;
    if (error || !result || (result.status !== "created" && result.status !== "exists")) {
      throw new LedgerError(409, `A managed dispute could not be applied (${result?.reason ?? error?.message ?? "refused"}).`);
    }
    return result.status;
  };
  // Events arrive out of order: a close can land before its creation. Opening is idempotent, so always open first.
  const opened = await call("opened");
  if (phase !== "opened") await call(phase);

  if (opened === "created" || phase !== "opened") {
    const { data: ws } = await db.from("portal_workspaces").select("owner_user_id").eq("id", workspaceId).maybeSingle();
    const manager = String((ws as { owner_user_id?: string } | null)?.owner_user_id ?? "");
    if (manager) {
      const text = phase === "opened"
        ? "A resident disputed a rent payment. The owner's share is frozen until it is decided."
        : phase === "won" ? "A rent dispute was decided in your favor. The owner's share is released."
          : "A rent dispute was lost. The owner's share and PropLane's fee were written off.";
      await alertManagerOfOwnerEvent(db, {
        managerUserId: manager, workspaceId, subject: "Rent dispute", text, key: `dispute:${dispute.id}:${phase}`, urgent: phase === "opened",
      });
    }
  }
  return true;
}
