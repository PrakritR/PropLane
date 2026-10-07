import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { recordVendorBankingLedgerEntry } from "@/lib/vendor-banking/ledger.server";

/**
 * Writes the vendor-ledger lines for one in-app withdrawal: a `withdrawal` debit
 * for what the bank receives and, for Instant, a separate `platform_fee` debit
 * (source `withdrawal`) for the Instant fee. Both are idempotent on the payout
 * id, so a retried request never double-posts. A ledger failure must never fail
 * the withdrawal that already happened — the caller logs and moves on; the
 * reconciliation stamp is what surfaces any drift.
 */
export async function recordVendorWithdrawalLedger(
  db: SupabaseClient,
  opts: {
    vendorUserId: string;
    payoutId: string;
    /** Gross amount the vendor asked to withdraw. */
    amountCents: number;
    feeCents: number;
    method: "standard" | "instant";
  },
): Promise<void> {
  const feeCents = opts.method === "instant" ? Math.max(0, Math.round(opts.feeCents)) : 0;
  const netCents = Math.max(0, Math.round(opts.amountCents) - feeCents);
  await recordVendorBankingLedgerEntry(db, {
    vendorUserId: opts.vendorUserId,
    kind: "withdrawal",
    amountCents: -netCents,
    source: "withdrawal",
    sourceId: opts.payoutId,
    description: opts.method === "instant" ? "Instant withdrawal" : "Standard withdrawal",
    stripeObjectId: opts.payoutId,
    idempotencyKey: `withdrawal:${opts.payoutId}:withdrawal`,
  });
  if (feeCents > 0) {
    await recordVendorBankingLedgerEntry(db, {
      vendorUserId: opts.vendorUserId,
      kind: "platform_fee",
      amountCents: -feeCents,
      source: "withdrawal",
      sourceId: opts.payoutId,
      description: "Instant payout fee",
      stripeObjectId: opts.payoutId,
      idempotencyKey: `withdrawal:${opts.payoutId}:instant_fee`,
    });
  }
}
