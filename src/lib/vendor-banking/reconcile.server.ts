import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import { resolveManagerConnectAccountId } from "@/lib/stripe-connect";
import { sumHeldCentsForOwner } from "@/lib/stripe-platform-hold.server";
import { listVendorUserIdsWithLedgerActivity, sumVendorBankingLedgerCents } from "@/lib/vendor-banking/ledger.server";

const CURRENCY = "usd";

function currencyAmount(rows: Array<{ amount: number; currency: string }> | undefined): number {
  return rows?.find((r) => r.currency === CURRENCY)?.amount ?? 0;
}

export type VendorReconciliationOutcome = {
  vendorUserId: string;
  matches: boolean;
  ledgerTotalCents: number;
  stripeTotalCents: number;
};

/**
 * The ledger's running total (every charge/fee/refund/withdrawal/adjustment
 * line ever posted for this vendor) should always equal their CURRENT real
 * position: what's on their connected account (Stripe available + pending)
 * plus whatever is still held on PropLane. Any drift is a bug, never
 * "expected" — this only reports it (the "Matches Stripe · last checked …"
 * stamp), it never auto-corrects the ledger.
 */
export async function reconcileVendorBankingLedger(
  stripe: Stripe,
  db: SupabaseClient,
  vendorUserId: string,
): Promise<VendorReconciliationOutcome> {
  const [ledgerTotalCents, accountId, heldCents] = await Promise.all([
    sumVendorBankingLedgerCents(db, vendorUserId),
    resolveManagerConnectAccountId(db, vendorUserId),
    sumHeldCentsForOwner(db, vendorUserId).catch(() => 0),
  ]);

  let stripeAvailableAndPendingCents = 0;
  if (accountId) {
    try {
      const balance = await stripe.balance.retrieve({}, { stripeAccount: accountId });
      stripeAvailableAndPendingCents = currencyAmount(balance.available) + currencyAmount(balance.pending);
    } catch (e) {
      console.error(`[vendor-banking] reconcile: could not read Stripe balance for ${vendorUserId}:`, e instanceof Error ? e.message : e);
    }
  }

  const stripeTotalCents = stripeAvailableAndPendingCents + heldCents;
  const matches = ledgerTotalCents === stripeTotalCents;

  await db
    .from("vendor_banking_reconciliation")
    .upsert(
      {
        vendor_user_id: vendorUserId,
        reconciled_at: new Date().toISOString(),
        matches,
        ledger_total_cents: ledgerTotalCents,
        stripe_total_cents: stripeTotalCents,
        note: matches ? null : `Drift of ${ledgerTotalCents - stripeTotalCents} cents`,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "vendor_user_id" },
    );

  return { vendorUserId, matches, ledgerTotalCents, stripeTotalCents };
}

export type ReconcileAllResult = { checked: number; matched: number; drifted: number; drifts: VendorReconciliationOutcome[] };

export async function reconcileAllVendorBankingLedgers(stripe: Stripe, db: SupabaseClient): Promise<ReconcileAllResult> {
  const vendorIds = await listVendorUserIdsWithLedgerActivity(db);
  const result: ReconcileAllResult = { checked: 0, matched: 0, drifted: 0, drifts: [] };
  for (const vendorUserId of vendorIds) {
    try {
      const outcome = await reconcileVendorBankingLedger(stripe, db, vendorUserId);
      result.checked += 1;
      if (outcome.matches) result.matched += 1;
      else {
        result.drifted += 1;
        result.drifts.push(outcome);
      }
    } catch (e) {
      console.error(`[vendor-banking] reconcile failed for ${vendorUserId}:`, e instanceof Error ? e.message : e);
    }
  }
  return result;
}
