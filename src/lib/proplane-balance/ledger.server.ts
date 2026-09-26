import "server-only";

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  parseInsufficientBalanceError,
  withdrawalReversedSentinel,
  type BalanceOwnerKind,
  type BalanceSnapshot,
} from "@/lib/proplane-balance/types";

const CURRENCY = "usd";

function isUniqueViolation(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "23505") return true;
  return /duplicate key|unique constraint/i.test(error.message ?? "");
}

/** Get-or-create the one ledger account for this owner (see the migration header for what `owner_key` means per `owner_kind`). */
export async function ensureBalanceAccountId(
  db: SupabaseClient,
  ownerKind: BalanceOwnerKind,
  ownerKey: string,
  currency = CURRENCY,
): Promise<string> {
  const key = ownerKey.trim();
  if (!key) throw new Error("owner key required");
  const { data, error } = await db.rpc("proplane_balance_ensure_account", {
    p_owner_kind: ownerKind,
    p_owner_key: key,
    p_currency: currency,
  });
  if (error) throw new Error(`Could not resolve balance account: ${error.message}`);
  const id = typeof data === "string" ? data : null;
  if (!id) throw new Error("Could not resolve balance account id.");
  return id;
}

export async function ensureWorkspaceBalanceAccountId(db: SupabaseClient, managerUserId: string): Promise<string> {
  return ensureBalanceAccountId(db, "workspace", managerUserId);
}

export async function ensureVendorBalanceAccountId(db: SupabaseClient, vendorUserId: string): Promise<string> {
  return ensureBalanceAccountId(db, "vendor", vendorUserId);
}

/** Flips any due pending entries to available, then reads the current snapshot. */
export async function readBalanceSnapshot(db: SupabaseClient, accountId: string): Promise<BalanceSnapshot> {
  const { error: settleError } = await db.rpc("proplane_balance_settle_due", { p_account_id: accountId });
  if (settleError) throw new Error(`Could not settle due balance entries: ${settleError.message}`);

  const [{ data: availableRaw, error: availableError }, { data: pendingRaw, error: pendingError }] = await Promise.all([
    db.rpc("proplane_balance_available_cents", { p_account_id: accountId }),
    db.rpc("proplane_balance_pending_cents", { p_account_id: accountId }),
  ]);
  if (availableError) throw new Error(`Could not read available balance: ${availableError.message}`);
  if (pendingError) throw new Error(`Could not read pending balance: ${pendingError.message}`);

  return {
    currency: CURRENCY,
    availableCents: Number(availableRaw) || 0,
    pendingCents: Number(pendingRaw) || 0,
  };
}

/**
 * Credits a pending `resident_payment` entry from a platform-ledger household
 * charge. Idempotent on `idempotencyKey` (the Stripe checkout session id) — a
 * webhook redelivery is a no-op, never a double credit. Becomes available once
 * `availableOnIso` passes (see `proplane_balance_settle_due`).
 */
export async function creditResidentPaymentPending(
  db: SupabaseClient,
  opts: { accountId: string; amountCents: number; availableOnIso: string; stripeChargeId: string; idempotencyKey: string },
): Promise<{ ok: true; alreadyCredited: boolean }> {
  if (opts.amountCents <= 0) throw new Error("amountCents must be positive.");
  const { error } = await db.from("proplane_balance_entries").insert({
    account_id: opts.accountId,
    amount_cents: opts.amountCents,
    kind: "resident_payment",
    status: "pending",
    available_on: opts.availableOnIso,
    stripe_object_id: opts.stripeChargeId,
    idempotency_key: opts.idempotencyKey,
  });
  if (error) {
    if (isUniqueViolation(error)) return { ok: true, alreadyCredited: true };
    throw new Error(`Could not credit resident payment to the balance ledger: ${error.message}`);
  }
  return { ok: true, alreadyCredited: false };
}

/**
 * Sum of money that left this account (a negative `vendor_payment_out` or
 * `withdrawal` leg — never `resident_payment`/`fee`/`adjustment` inflows) with
 * `created_at` inside the current UTC calendar month. Read-only, no
 * `settle_due` needed first (settling only ever moves pending → available; it
 * never changes an entry's `created_at` or amount). Used for the Financials
 * Overview's "Paid this month" figure — closing the loop between the balance
 * card and the Pay vendors / Withdraw actions that spend it.
 */
export async function readBalancePaidThisMonthCents(db: SupabaseClient, accountId: string): Promise<number> {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const { data, error } = await db
    .from("proplane_balance_entries")
    .select("amount_cents")
    .eq("account_id", accountId)
    .in("kind", ["vendor_payment_out", "withdrawal"])
    .eq("status", "available")
    .gte("created_at", monthStart);
  if (error) throw new Error(`Could not read this month's balance spend: ${error.message}`);
  const rows = (data ?? []) as Array<{ amount_cents: number | null }>;
  const totalCents = rows.reduce((sum, row) => sum + Math.abs(Number(row.amount_cents) || 0), 0);
  return totalCents;
}

export type PayVendorFromBalanceResult =
  | { ok: true; payerEntryId: string; payeeEntryId: string }
  | { ok: false; code: "insufficient_balance"; availableCents: number; requestedCents: number; shortfallCents: number }
  | { ok: false; code: "error"; error: string };

/**
 * Workspace → vendor internal move for "Pay from PropLane balance" — no
 * Stripe call, both sides of the double entry post inside one DB transaction
 * (`proplane_balance_move`). `idempotencyRoot` should be stable per invoice
 * (e.g. `vendor-invoice:<id>`) so a retried request can never pay twice.
 */
export async function payVendorFromBalance(
  db: SupabaseClient,
  opts: { managerUserId: string; vendorUserId: string; amountCents: number; idempotencyRoot: string },
): Promise<PayVendorFromBalanceResult> {
  const workspaceAccountId = await ensureWorkspaceBalanceAccountId(db, opts.managerUserId);
  const vendorAccountId = await ensureVendorBalanceAccountId(db, opts.vendorUserId);

  const { data, error } = await db.rpc("proplane_balance_move", {
    p_payer_account_id: workspaceAccountId,
    p_payee_account_id: vendorAccountId,
    p_amount_cents: opts.amountCents,
    p_payer_kind: "vendor_payment_out",
    p_payee_kind: "vendor_payment_in",
    p_idempotency_root: opts.idempotencyRoot,
  });

  if (error) {
    const insufficient = parseInsufficientBalanceError(error.message);
    if (insufficient) {
      return {
        ok: false,
        code: "insufficient_balance",
        availableCents: insufficient.availableCents,
        requestedCents: insufficient.requestedCents,
        shortfallCents: insufficient.shortfallCents,
      };
    }
    return { ok: false, code: "error", error: error.message };
  }
  const row = Array.isArray(data) ? data[0] : data;
  const payerEntryId = row?.payer_entry_id as string | undefined;
  const payeeEntryId = row?.payee_entry_id as string | undefined;
  if (!payerEntryId || !payeeEntryId) {
    return { ok: false, code: "error", error: "Balance move did not return entry ids." };
  }
  return { ok: true, payerEntryId, payeeEntryId };
}

export type ClaimWithdrawalResult =
  | { ok: true; entryId: string; idempotencyKey: string }
  | { ok: false; code: "conflict"; error: string }
  | { ok: false; code: "insufficient_balance"; availableCents: number }
  | { ok: false; code: "error"; error: string };

/**
 * Claim-before-call: writes the debit BEFORE any Stripe request, same pattern
 * as `createInAppPayout` (`stripe-payouts.server.ts`). The partial unique
 * index `proplane_balance_withdrawal_claim_unique` makes a second concurrent
 * claim on the same account lose the insert race (409-mapped `conflict`), and
 * because the debit posts immediately (`status: "available"`), the balance a
 * second request reads already reflects this claim — no separate lock needed.
 */
export async function claimWithdrawal(
  db: SupabaseClient,
  opts: { accountId: string; amountCents: number },
): Promise<ClaimWithdrawalResult> {
  if (opts.amountCents <= 0) return { ok: false, code: "error", error: "Amount must be positive." };

  const { error: settleError } = await db.rpc("proplane_balance_settle_due", { p_account_id: opts.accountId });
  if (settleError) return { ok: false, code: "error", error: settleError.message };

  const { data: availableRaw, error: availableError } = await db.rpc("proplane_balance_available_cents", {
    p_account_id: opts.accountId,
  });
  if (availableError) return { ok: false, code: "error", error: availableError.message };
  const availableCents = Number(availableRaw) || 0;
  if (availableCents < opts.amountCents) {
    return { ok: false, code: "insufficient_balance", availableCents };
  }

  const idempotencyKey = `withdrawal:${randomUUID()}`;
  const { data: claimed, error: claimError } = await db
    .from("proplane_balance_entries")
    .insert({
      account_id: opts.accountId,
      amount_cents: -opts.amountCents,
      kind: "withdrawal",
      status: "available",
      available_on: new Date().toISOString(),
      stripe_object_id: null,
      idempotency_key: idempotencyKey,
    })
    .select("id")
    .maybeSingle();
  if (claimError || !claimed) {
    if (isUniqueViolation(claimError)) {
      return { ok: false, code: "conflict", error: "A withdrawal is already in progress for this account." };
    }
    return { ok: false, code: "error", error: claimError?.message ?? "Could not claim the withdrawal." };
  }
  return { ok: true, entryId: (claimed as { id: string }).id, idempotencyKey };
}

/** Stamps a claimed withdrawal with the real Stripe transfer id once it succeeds — frees the claim slot. */
export async function stampWithdrawalTransfer(
  db: SupabaseClient,
  opts: { entryId: string; transferId: string },
): Promise<void> {
  const { error } = await db
    .from("proplane_balance_entries")
    .update({ stripe_object_id: opts.transferId })
    .eq("id", opts.entryId);
  if (error) throw new Error(`Could not stamp withdrawal transfer: ${error.message}`);
}

/**
 * The `transfers.create` call itself failed — no real money left the platform
 * balance, so the claimed debit is reversed with a mirror `withdrawal_reversal`
 * credit (never deleted — the failed attempt stays in the audit trail) and the
 * claim slot is freed with a timestamped sentinel. Never call this once a
 * transfer has actually been created: if only the follow-up `payouts.create`
 * fails, the money already left the platform balance for the recipient's own
 * Connect account and is real, withdrawable money there — reversing the ledger
 * would manufacture cents that do not exist on the platform side.
 */
export async function reverseWithdrawalClaim(
  db: SupabaseClient,
  opts: { entryId: string; accountId: string; amountCents: number },
): Promise<void> {
  const sentinel = withdrawalReversedSentinel();
  const { error: stampError } = await db
    .from("proplane_balance_entries")
    .update({ stripe_object_id: sentinel })
    .eq("id", opts.entryId);
  if (stampError) throw new Error(`Could not release the withdrawal claim: ${stampError.message}`);

  const { error: reversalError } = await db.from("proplane_balance_entries").insert({
    account_id: opts.accountId,
    amount_cents: opts.amountCents,
    kind: "withdrawal_reversal",
    status: "available",
    available_on: new Date().toISOString(),
    stripe_object_id: null,
    related_entry_id: opts.entryId,
    idempotency_key: `${opts.entryId}:reversal`,
  });
  if (reversalError && !isUniqueViolation(reversalError)) {
    throw new Error(`Could not record the withdrawal reversal: ${reversalError.message}`);
  }
}
