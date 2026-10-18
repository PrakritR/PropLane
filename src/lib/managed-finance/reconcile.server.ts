import "server-only";

import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { reconcileWithdrawals } from "@/lib/managed-finance/withdrawals.server";

/**
 * Daily reconciliation of the party ledger (docs/agents/owner-management.md § Ledger). It reports and flags; it never corrects.
 */

export type ReconcileReport = {
  journalsBalanced: boolean;
  ledgerNetsToZero: boolean;
  stripeCoversPlatformCash: boolean | null;
  capturesChecked: number;
  capturesMismatched: number;
  withdrawals: { completed: number; failed: number; retried: number };
  flagged: number;
};

type Totals = Array<{ account: string; total: number | string }>;

async function flag(db: SupabaseClient, check: string, subject: string, detail: Record<string, unknown>): Promise<boolean> {
  const { error } = await db.from("owner_ledger_flags").upsert({ check_name: check, subject, detail }, { onConflict: "check_name,subject,day", ignoreDuplicates: true });
  return !error;
}

export async function reconcileManagedLedger(db: SupabaseClient, stripe: Stripe, now: Date = new Date()): Promise<ReconcileReport> {
  let flagged = 0;
  const withdrawals = await reconcileWithdrawals(stripe, db, now);

  const [{ data: unbalanced }, { data: totalsData }] = await Promise.all([db.rpc("party_ledger_unbalanced_journals"), db.rpc("platform_ledger_totals")]);
  const journalsBalanced = ((unbalanced ?? []) as unknown[]).length === 0;
  if (!journalsBalanced && (await flag(db, "journal_unbalanced", "ledger", { count: (unbalanced as unknown[]).length }))) flagged += 1;

  const totals = (totalsData ?? []) as Totals;
  const sum = totals.reduce((s, t) => s + Number(t.total), 0);
  const cash = Number(totals.find((t) => t.account === "platform_cash")?.total ?? 0);
  const ledgerNetsToZero = sum === 0;
  if (!ledgerNetsToZero && (await flag(db, "ledger_not_zero", "ledger", { sum }))) flagged += 1;

  // The managed money has to actually be at Stripe: available + pending >= platform cash attributable to managed workspaces.
  let stripeCoversPlatformCash: boolean | null = null;
  try {
    const balance = await stripe.balance.retrieve();
    const usd = [...balance.available, ...balance.pending].filter((b) => b.currency === "usd").reduce((s, b) => s + b.amount, 0);
    stripeCoversPlatformCash = usd >= cash;
    if (!stripeCoversPlatformCash && (await flag(db, "stripe_short", "platform_cash", { stripe: usd, ledger_cash: cash }))) flagged += 1;
  } catch {
    stripeCoversPlatformCash = null;
  }

  // Each recent capture equals the Charge at Stripe (amount and PaymentIntent).
  const since = new Date(now.getTime() - 3 * 86_400_000).toISOString();
  const { data: caps } = await db
    .from("party_ledger_journals")
    .select("id, stripe_object_id, detail")
    .eq("kind", "rent_capture")
    .gte("created_at", since)
    .limit(100);
  let checked = 0;
  let mismatched = 0;
  for (const j of (caps ?? []) as Array<{ id: string; stripe_object_id: string | null; detail: { stripe_charge?: string; gross_cents?: number } }>) {
    const chargeId = j.detail?.stripe_charge;
    if (!chargeId) continue;
    checked += 1;
    try {
      const charge = await stripe.charges.retrieve(chargeId);
      const pi = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
      if (charge.amount !== j.detail.gross_cents || (j.stripe_object_id && pi !== j.stripe_object_id)) {
        mismatched += 1;
        if (await flag(db, "capture_mismatch", j.id, { charge: chargeId, ledger: j.detail.gross_cents, stripe: charge.amount })) flagged += 1;
      }
    } catch {
      mismatched += 1;
      if (await flag(db, "capture_unreadable", j.id, { charge: chargeId })) flagged += 1;
    }
  }
  return { journalsBalanced, ledgerNetsToZero, stripeCoversPlatformCash, capturesChecked: checked, capturesMismatched: mismatched, withdrawals, flagged };
}
