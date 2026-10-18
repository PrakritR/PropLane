import "server-only";

import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { retrieveManagerConnectAccountOrNull } from "@/lib/stripe-connect";
import { resolvePayoutsReadiness } from "@/lib/stripe-payouts-readiness.server";
import { alertManagerOfOwnerEvent } from "@/lib/owner-management/alerts.server";
import { listPoliciesForWorkspace } from "@/lib/owner-management/policies.server";
import {
  availableToWithdraw,
  LedgerError,
  ownerParty,
  readPartyBalance,
  vendorParty,
} from "@/lib/managed-finance/ledger.server";

/**
 * Withdrawals from PropLane-held funds (docs/agents/owner-management.md § Stripe model). Reserve in the ledger first, under a
 * per-party lock and against the ledger's own figure; then a Stripe Transfer to the person's own Express account (idempotent per
 * withdrawal); then a best-effort payout to their bank. The transfer is the money event: a payout that fails never reverses it.
 */

export const MIN_WITHDRAWAL_CENTS = 100;
export const WEEKLY_BATCH_MIN_CENTS = 2500;

export type WithdrawInput = {
  kind: "owner" | "vendor";
  /** The authenticated person. Never a request value. */
  userId: string;
  /** Owner withdrawals are per managed workspace; the caller proves the workspace by the policy lookup below. */
  workspaceId?: string | null;
  amountCents: number;
  /** One per click / batch; a repeat with the same key returns the first outcome. */
  clientKey?: string;
  source?: "manual" | "weekly_batch";
};

export type WithdrawResult =
  | { ok: true; withdrawalId: string; transferId: string; payoutId: string | null; payoutPending: boolean; payoutError?: string }
  | { ok: false; status: 400 | 402 | 403 | 409 | 422 | 500 | 503; error: string; code?: string };

function idOf(v: string | { id: string } | null | undefined): string | null {
  return typeof v === "string" ? v : v?.id ?? null;
}

/** The platform's available USD balance at Stripe, in cents. */
export async function platformAvailableCents(stripe: Stripe): Promise<number> {
  const balance = await stripe.balance.retrieve();
  return balance.available.filter((b) => b.currency === "usd").reduce((s, b) => s + b.amount, 0);
}

/** A person's own payout account, proven ready: their account id, metadata pinned to them, identity and bank done. */
export async function resolvePayoutDestination(stripe: Stripe, db: SupabaseClient, userId: string): Promise<{ accountId: string } | { error: string }> {
  const { data } = await db.from("profiles").select("stripe_connect_account_id").eq("id", userId).maybeSingle();
  const accountId = String((data as { stripe_connect_account_id?: string | null } | null)?.stripe_connect_account_id ?? "").trim();
  if (!accountId) return { error: "Finish payout setup before withdrawing." };
  const account = await retrieveManagerConnectAccountOrNull(stripe, accountId);
  if (!account || account.id !== accountId || account.metadata?.axis_user_id !== userId || !resolvePayoutsReadiness(account).ready) {
    return { error: "Finish payout setup before withdrawing." };
  }
  return { accountId };
}

/** Reserve amounts and sources for the party; re-derives the reserve target and proves an owner's workspace. */
async function resolveParty(db: SupabaseClient, input: WithdrawInput): Promise<
  | { partyId: string; workspaceId: string | null; reserveCents: number; account: "owner_payable" | "vendor_payable" }
  | { error: string; status: 403 | 404 }
> {
  if (input.kind === "vendor") {
    return { partyId: vendorParty(input.userId), workspaceId: null, reserveCents: 0, account: "vendor_payable" };
  }
  const workspaceId = input.workspaceId?.trim() ?? "";
  if (!workspaceId) return { error: "Choose a workspace.", status: 404 };
  const policies = await listPoliciesForWorkspace(db, workspaceId);
  const mine = policies.filter((p) => p.ownerUserId === input.userId && p.signedAt);
  if (mine.length === 0) return { error: "Not found.", status: 404 };
  // An ended agreement still lets the owner withdraw what they are owed; only an active one holds back a reserve.
  const active = mine.find((p) => p.status === "active");
  return { partyId: ownerParty(input.userId), workspaceId, reserveCents: active?.terms.reserveTargetCents ?? 0, account: "owner_payable" };
}

export async function withdrawFromManagedFunds(stripe: Stripe, db: SupabaseClient, input: WithdrawInput): Promise<WithdrawResult> {
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents < MIN_WITHDRAWAL_CENTS) {
    return { ok: false, status: 400, error: "Enter at least $1.00." };
  }
  let party: Awaited<ReturnType<typeof resolveParty>>;
  try {
    party = await resolveParty(db, input);
  } catch {
    return { ok: false, status: 503, error: "Could not check your account. Try again in a moment." };
  }
  if ("error" in party) return { ok: false, status: party.status === 404 ? 403 : party.status, error: party.error };

  const destination = await resolvePayoutDestination(stripe, db, input.userId).catch(() => ({ error: "Could not check your payout account. Try again." }));
  if ("error" in destination) return { ok: false, status: 402, error: destination.error, code: "PAYOUTS_NOT_READY" };

  const key = `wd:${input.kind}:${party.partyId}:${party.workspaceId ?? "-"}:${input.clientKey?.trim() || randomUUID()}`;

  // A repeat of a click that already completed returns that withdrawal as it was: no Stripe call, no balance question.
  const { data: prior } = await db
    .from("party_withdrawals")
    .select("id, status, amount_cents, stripe_transfer_id, stripe_payout_id, party_id")
    .eq("idempotency_key", key)
    .maybeSingle();
  const priorRow = prior as { id?: string; status?: string; amount_cents?: number | string; stripe_transfer_id?: string | null; stripe_payout_id?: string | null; party_id?: string } | null;
  if (priorRow?.status === "completed" && priorRow.party_id === party.partyId && Number(priorRow.amount_cents) === input.amountCents && priorRow.stripe_transfer_id) {
    return { ok: true, withdrawalId: String(priorRow.id), transferId: priorRow.stripe_transfer_id, payoutId: priorRow.stripe_payout_id ?? null, payoutPending: !priorRow.stripe_payout_id };
  }

  // The ledger and Stripe must agree before anything is reserved: PropLane's platform balance at Stripe has to hold the money.
  let platform: number;
  try {
    platform = await platformAvailableCents(stripe);
  } catch {
    return { ok: false, status: 503, error: "Could not confirm PropLane's balance. Try again in a moment." };
  }
  if (platform < input.amountCents) {
    return { ok: false, status: 409, code: "FUNDS_CLEARING", error: "Those funds are still arriving. Try again later today." };
  }

  const { data: reserved, error: reserveError } = await db.rpc("reserve_party_withdrawal", {
    p_kind: input.kind, p_party: party.partyId, p_workspace: party.workspaceId, p_amount: input.amountCents,
    p_destination: destination.accountId, p_key: key, p_reserve: party.reserveCents, p_source: input.source ?? "manual",
  });
  const r = reserved as { status?: string; withdrawal_id?: string; withdrawal_status?: string; available?: number } | null;
  if (reserveError || !r) return { ok: false, status: 500, error: "Could not start the withdrawal." };
  if (r.status === "in_flight") return { ok: false, status: 409, code: "IN_FLIGHT", error: "A withdrawal is already on its way." };
  if (r.status === "insufficient") {
    return { ok: false, status: 422, code: "INSUFFICIENT", error: `Only $${((r.available ?? 0) / 100).toFixed(2)} is available to withdraw.` };
  }
  if (r.status !== "reserved" && r.status !== "exists") return { ok: false, status: 400, error: "That withdrawal was refused." };
  const withdrawalId = String(r.withdrawal_id);
  if (r.status === "exists" && r.withdrawal_status === "failed") return { ok: false, status: 409, error: "That withdrawal failed. Start a new one." };
  return carryOutWithdrawal(stripe, db, {
    withdrawalId, amountCents: input.amountCents, destinationAccountId: destination.accountId,
    partyKind: input.kind, partyId: party.partyId, workspaceId: party.workspaceId,
  });
}

type Carry = { withdrawalId: string; amountCents: number; destinationAccountId: string; partyKind: "owner" | "vendor"; partyId: string; workspaceId: string | null };

/** Transfer, record, then a best-effort payout. Idempotent on the withdrawal id end to end. */
export async function carryOutWithdrawal(stripe: Stripe, db: SupabaseClient, w: Carry): Promise<WithdrawResult> {
  let transfer: Stripe.Transfer;
  try {
    transfer = await stripe.transfers.create(
      {
        amount: w.amountCents, currency: "usd", destination: w.destinationAccountId, transfer_group: `wd_${w.withdrawalId}`,
        metadata: { withdrawal_id: w.withdrawalId, party_kind: w.partyKind, party_id: w.partyId, workspace_id: w.workspaceId ?? "" },
      },
      { idempotencyKey: `party-withdrawal:${w.withdrawalId}` },
    );
  } catch (e) {
    const type = (e as { type?: string }).type ?? "";
    const definitive = type === "StripeInvalidRequestError" || type === "StripeCardError" || type === "StripePermissionError";
    if (definitive) {
      await db.rpc("fail_party_withdrawal", { p_id: w.withdrawalId, p_reason: (e as Error).message ?? "Stripe refused the transfer." });
      return { ok: false, status: 409, error: "Stripe could not send those funds. Nothing was withdrawn." };
    }
    // A timeout or 5xx can follow a created transfer. Keep the reservation; reconciliation settles it with the same key.
    await db.rpc("mark_party_withdrawal_unknown", { p_id: w.withdrawalId });
    return { ok: false, status: 409, code: "VERIFYING", error: "The withdrawal is being verified. Do not submit it again." };
  }

  if (transfer.amount !== w.amountCents || transfer.currency !== "usd" || idOf(transfer.destination) !== w.destinationAccountId ||
      transfer.metadata?.withdrawal_id !== w.withdrawalId) {
    await db.rpc("mark_party_withdrawal_unknown", { p_id: w.withdrawalId });
    await flag(db, "withdrawal_transfer_mismatch", w.withdrawalId, { transfer: transfer.id });
    return { ok: false, status: 409, code: "VERIFYING", error: "The withdrawal is being verified. Do not submit it again." };
  }

  let payoutId: string | null = null;
  let payoutError: string | undefined;
  try {
    const payout = await stripe.payouts.create(
      { amount: w.amountCents, currency: "usd", method: "standard", metadata: { withdrawal_id: w.withdrawalId, transfer_id: transfer.id } },
      { stripeAccount: w.destinationAccountId, idempotencyKey: `party-withdrawal-payout:${w.withdrawalId}` },
    );
    payoutId = payout.id;
  } catch (e) {
    payoutError = e instanceof Error ? e.message : "The payout to your bank could not be started.";
  }
  const { data: done, error } = await db.rpc("complete_party_withdrawal", {
    p_id: w.withdrawalId, p_transfer: transfer.id, p_payout: payoutId, p_payout_error: payoutError ?? null,
  });
  const d = done as { status?: string } | null;
  if (error || !d || (d.status !== "completed" && d.status !== "exists")) {
    // The transfer is real. Leave the reservation in place for reconciliation rather than reversing money that left.
    await db.rpc("mark_party_withdrawal_unknown", { p_id: w.withdrawalId });
    await flag(db, "withdrawal_not_recorded", w.withdrawalId, { transfer: transfer.id });
    return { ok: false, status: 503, code: "VERIFYING", error: "The withdrawal is being recorded. Do not submit it again." };
  }
  return { ok: true, withdrawalId: w.withdrawalId, transferId: transfer.id, payoutId, payoutPending: payoutId === null, ...(payoutError ? { payoutError } : {}) };
}

async function flag(db: SupabaseClient, check: string, subject: string, detail: Record<string, unknown>): Promise<void> {
  await db.from("owner_ledger_flags").upsert({ check_name: check, subject, detail }, { onConflict: "check_name,subject,day", ignoreDuplicates: true }).then(undefined, () => undefined);
}

/**
 * Settle withdrawals a crash or timeout left in `reserved` / `unknown`. The transfer group names the withdrawal, so an
 * existing transfer is found by listing (never by retrying past Stripe's 24h idempotency window); only a young reservation with
 * no transfer is retried with its own key. Anything older with no transfer fails and releases the reservation.
 */
export async function reconcileWithdrawals(stripe: Stripe, db: SupabaseClient, now: Date = new Date()): Promise<{ completed: number; failed: number; retried: number }> {
  const { data, error } = await db
    .from("party_withdrawals")
    .select("id, party_kind, party_id, workspace_id, amount_cents, destination_account_id, status, created_at")
    .in("status", ["reserved", "unknown"])
    .lt("created_at", new Date(now.getTime() - 2 * 60_000).toISOString())
    .limit(100);
  if (error) {
    if (String(error.code) === "42P01" || String(error.code) === "PGRST205") return { completed: 0, failed: 0, retried: 0 };
    throw new LedgerError(500, "Could not read withdrawals.");
  }
  let completed = 0, failed = 0, retried = 0;
  for (const raw of (data ?? []) as Array<Record<string, unknown>>) {
    const w: Carry = {
      withdrawalId: String(raw.id), amountCents: Number(raw.amount_cents), destinationAccountId: String(raw.destination_account_id),
      partyKind: raw.party_kind as "owner" | "vendor", partyId: String(raw.party_id), workspaceId: (raw.workspace_id as string | null) ?? null,
    };
    const found = await stripe.transfers.list({ transfer_group: `wd_${w.withdrawalId}`, limit: 3 });
    const match = found.data.find((t) => t.metadata?.withdrawal_id === w.withdrawalId && t.amount === w.amountCents && idOf(t.destination) === w.destinationAccountId);
    if (match) {
      const { data: done } = await db.rpc("complete_party_withdrawal", { p_id: w.withdrawalId, p_transfer: match.id, p_payout: null, p_payout_error: "Payout not started." });
      if ((done as { status?: string } | null)?.status === "completed") completed += 1;
      continue;
    }
    const ageMs = now.getTime() - Date.parse(String(raw.created_at));
    if (ageMs < 20 * 3600_000) {
      const result = await carryOutWithdrawal(stripe, db, w);
      if (result.ok) completed += 1;
      retried += 1;
    } else {
      await db.rpc("fail_party_withdrawal", { p_id: w.withdrawalId, p_reason: "No transfer was found at Stripe." });
      await flag(db, "withdrawal_expired", w.withdrawalId, {});
      failed += 1;
    }
  }
  return { completed, failed, retried };
}

/** The Monday (Pacific) a weekly batch belongs to, `YYYY-MM-DD`. */
export function batchWeekKey(now: Date): string {
  const pacific = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short" }).format(now);
  const back = ({ Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 } as Record<string, number>)[weekday] ?? 0;
  const d = new Date(`${pacific}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

/**
 * One Stripe transfer per vendor per week, not per job: every vendor with at least $25 available and payouts ready.
 * Idempotent per (vendor, week) through the withdrawal key, so a re-run of the cron pays nobody twice.
 */
export async function runWeeklyVendorBatch(stripe: Stripe, db: SupabaseClient, now: Date = new Date()): Promise<{ paid: number; skipped: number; failed: number }> {
  const { data, error } = await db.from("party_ledger_lines").select("party_id").eq("account", "vendor_payable").limit(5000);
  if (error) {
    if (String(error.code) === "42P01" || String(error.code) === "PGRST205") return { paid: 0, skipped: 0, failed: 0 };
    throw new LedgerError(500, "Could not read vendor balances.");
  }
  const vendors = [...new Set(((data ?? []) as Array<{ party_id: string | null }>).map((r) => r.party_id ?? "").filter((p) => p.startsWith("vendor:")))];
  const week = batchWeekKey(now);
  let paid = 0, skipped = 0, failed = 0;
  for (const party of vendors) {
    const userId = party.slice("vendor:".length);
    const balance = await readPartyBalance(db, "vendor_payable", party, null);
    const available = availableToWithdraw(balance, 0);
    if (available < WEEKLY_BATCH_MIN_CENTS) { skipped += 1; continue; }
    const result = await withdrawFromManagedFunds(stripe, db, { kind: "vendor", userId, amountCents: available, clientKey: `batch:${week}`, source: "weekly_batch" });
    if (result.ok) paid += 1;
    else if (result.status === 402 || result.status === 409 || result.status === 422) skipped += 1;
    else failed += 1;
  }
  return { paid, skipped, failed };
}

/** A tell-the-manager note when an owner withdraws, so the service team sees cash leaving. */
export async function noteOwnerWithdrawal(db: SupabaseClient, input: { workspaceId: string; amountCents: number; withdrawalId: string }): Promise<void> {
  const { data } = await db.from("portal_workspaces").select("owner_user_id").eq("id", input.workspaceId).maybeSingle();
  const manager = String((data as { owner_user_id?: string } | null)?.owner_user_id ?? "");
  if (!manager) return;
  await alertManagerOfOwnerEvent(db, {
    managerUserId: manager, workspaceId: input.workspaceId, subject: "Owner withdrawal",
    text: `The owner withdrew $${(input.amountCents / 100).toFixed(2)}.`, key: `withdrawal:${input.withdrawalId}`,
  });
}
