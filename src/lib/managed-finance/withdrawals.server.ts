import "server-only";

import { createHash, randomUUID } from "node:crypto";
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
const VENDOR_PARTY_PAGE_SIZE = 1000;
const VENDOR_PARTY_MAX_PAGES = 1000;

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
  | {
      ok: true; withdrawalId: string; transferId: string; payoutId: string | null; payoutPending: boolean;
      payoutError?: string; payoutAutomatic?: true;
      /** The schedule read failed, so no bank payout was started and none is promised; the reconciler finishes it. */
      payoutScheduleUnknown?: true;
    }
  | { ok: false; status: 400 | 402 | 403 | 409 | 422 | 500 | 503; error: string; code?: string };

/**
 * "The transfer landed but no bank payout has started yet" is a CONTROL, not a sentence.
 *
 * `reconcileWithdrawals` finds those rows by matching the machine code below on `payout_error`, so the code and the
 * copy are stored together but read apart: the sweep matches `PAYOUT_PENDING_VERIFICATION#<attempts>` and never the
 * words, so re-wording (or translating) the sentence cannot orphan a row mid-flight. The attempt count rides in the
 * marker because it is what the back-off is computed from - `party_withdrawals` has no retry column of its own.
 */
const PAYOUT_PENDING_VERIFICATION_CODE = "PAYOUT_PENDING_VERIFICATION";

/** The sentence a person is shown while the payout is still being worked out. Copy only - never matched. */
export const PAYOUT_PENDING_VERIFICATION_MESSAGE = "We could not start your bank payout yet. We will check and finish it.";

/** What goes in `payout_error`: the machine code, its attempt count, then the copy. */
export function payoutPendingVerificationMarker(attempts: number): string {
  const n = Number.isFinite(attempts) ? Math.max(0, Math.trunc(attempts)) : 0;
  return `${PAYOUT_PENDING_VERIFICATION_CODE}#${n} ${PAYOUT_PENDING_VERIFICATION_MESSAGE}`;
}

/** The attempt count on a marked row, or null when this `payout_error` is not the marker. */
export function readPayoutPendingVerification(value: unknown): { attempts: number } | null {
  const match = new RegExp(`^${PAYOUT_PENDING_VERIFICATION_CODE}#(\\d+)(?:\\s|$)`).exec(String(value ?? ""));
  return match ? { attempts: Number(match[1]) } : null;
}

/** Back-off between sweep attempts: 15 minutes doubling to a day, so a broken destination is not hammered hourly. */
const PAYOUT_RETRY_BASE_MS = 15 * 60_000;
const PAYOUT_RETRY_MAX_MS = 24 * 3600_000;
/** After this many attempts the row is flagged for a person, while the sweep keeps trying. */
const PAYOUT_RETRY_FLAG_AFTER = 5;

/**
 * Does this Stripe failure mean "never going to work" rather than "not right now"? Same classification the transfer
 * uses: an invalid request, a declined card or a permission problem is the destination's own state, and anything else
 * (a 429, a 5xx, a dropped connection) is worth another go.
 */
function stripeFailureIsDefinitive(e: unknown): boolean {
  const type = (e as { type?: string } | null)?.type ?? "";
  return type === "StripeInvalidRequestError" || type === "StripeCardError" || type === "StripePermissionError";
}

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

  const key = withdrawalKey(input, party.partyId, party.workspaceId);

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
  const r = reserved as ReserveResult | null;
  if (reserveError || !r) return { ok: false, status: 500, error: "Could not start the withdrawal." };
  if (r.status === "in_flight") return { ok: false, status: 409, code: "IN_FLIGHT", error: "A withdrawal is already on its way." };
  if (r.status === "insufficient") {
    return { ok: false, status: 422, code: "INSUFFICIENT", error: `Only $${((r.available ?? 0) / 100).toFixed(2)} is available to withdraw.` };
  }
  if (r.status !== "reserved" && r.status !== "exists") return { ok: false, status: 400, error: "That withdrawal was refused." };
  const withdrawalId = String(r.withdrawal_id);
  if (r.status === "reserved") {
    return carryOutWithdrawal(stripe, db, {
      withdrawalId, amountCents: input.amountCents, destinationAccountId: destination.accountId,
      partyKind: input.kind, partyId: party.partyId, workspaceId: party.workspaceId,
    });
  }

  // `exists`: the key was used before. What was STORED decides everything; the request's amount and destination never do.
  const storedAmount = Number(r.amount_cents);
  const storedDestination = String(r.destination_account_id ?? "");
  const storedParty = String(r.party_id ?? "");
  if (!Number.isSafeInteger(storedAmount) || !storedDestination || !storedParty) {
    return { ok: false, status: 409, code: "VERIFYING", error: "The withdrawal is being verified. Do not submit it again." };
  }
  if (storedAmount !== input.amountCents || storedParty !== party.partyId || storedDestination !== destination.accountId) {
    return { ok: false, status: 409, code: "KEY_REUSED", error: "That withdrawal request was already used for something else. Start a new one." };
  }
  if (r.withdrawal_status === "failed") return { ok: false, status: 409, error: "That withdrawal failed. Start a new one." };
  if (r.withdrawal_status === "completed") {
    if (!r.stripe_transfer_id) return { ok: false, status: 409, code: "VERIFYING", error: "The withdrawal is being verified. Do not submit it again." };
    return { ok: true, withdrawalId, transferId: r.stripe_transfer_id, payoutId: r.stripe_payout_id ?? null, payoutPending: !r.stripe_payout_id };
  }
  // Still reserved / unknown. Only a young reservation is carried out here (inside Stripe's idempotency window); anything older
  // is settled by reconciliation, which lists the transfer group first, so a second transfer can never be created past the window.
  const ageMs = Date.now() - Date.parse(String(r.created_at ?? ""));
  if (r.withdrawal_status !== "reserved" || !Number.isFinite(ageMs) || ageMs > RETRY_WINDOW_MS) {
    return { ok: false, status: 409, code: "VERIFYING", error: "The withdrawal is being verified. Do not submit it again." };
  }
  return carryOutWithdrawal(stripe, db, {
    withdrawalId, amountCents: storedAmount, destinationAccountId: storedDestination,
    partyKind: input.kind, partyId: storedParty, workspaceId: party.workspaceId,
  });
}

/** Stripe remembers an idempotency key for 24h; a reservation is only re-carried-out well inside that. */
const RETRY_WINDOW_MS = 20 * 3600_000;

type ReserveResult = {
  status?: string; withdrawal_id?: string; withdrawal_status?: string; available?: number;
  amount_cents?: number | string; party_id?: string; destination_account_id?: string;
  stripe_transfer_id?: string | null; stripe_payout_id?: string | null; created_at?: string;
};

/**
 * The idempotency key stored on the reservation. A manual click's key is bound to its amount, so a client key reused with a
 * different amount is a different withdrawal (balance-checked and reserved afresh), never the old reservation carried out for a
 * new number. A weekly batch key is server-made and leaves the amount out: its retry with a changed balance is refused instead.
 */
export function withdrawalKey(input: Pick<WithdrawInput, "kind" | "amountCents" | "clientKey" | "source">, partyId: string, workspaceId: string | null): string {
  const base = `wd:${input.kind}:${partyId}:${workspaceId ?? "-"}:`;
  const client = input.clientKey?.trim();
  if (!client) return `${base}${randomUUID()}`;
  if (input.source === "weekly_batch") return `${base}${client}`;
  const bound = createHash("sha256").update(`${client}\u0000${partyId}\u0000${workspaceId ?? ""}\u0000${input.amountCents}`).digest("hex").slice(0, 40);
  return `${base}${bound}`;
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
      { idempotencyKey: `party-withdrawal:${w.withdrawalId}:${w.partyId}:${w.amountCents}` },
    );
  } catch (e) {
    if (stripeFailureIsDefinitive(e)) {
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
  // What the ROW carries, which is not what the person is told: a payout still worth another attempt is marked so the
  // sweep comes back for it, while the person reads whatever actually happened.
  let storedPayoutError: string | null = null;
  // An account on Stripe's AUTOMATIC payout schedule pays itself out: asking for a manual payout on it errors after the transfer
  // landed. Only a schedule read as `manual` gets a payout created here. An UNREADABLE schedule is left to Stripe's own
  // schedule too (automatic is the Express default), because guessing `manual` on an automatic account is exactly the
  // post-transfer error this reads the schedule to avoid; the money is in the recipient's own account either way.
  const schedule = await payoutScheduleOf(stripe, w.destinationAccountId);
  const payoutAutomatic = schedule === "automatic";
  if (schedule === "unknown") {
    payoutError = PAYOUT_PENDING_VERIFICATION_MESSAGE;
    storedPayoutError = payoutPendingVerificationMarker(0);
  }
  if (schedule === "manual") try {
    const payout = await stripe.payouts.create(
      { amount: w.amountCents, currency: "usd", method: "standard", metadata: { withdrawal_id: w.withdrawalId, transfer_id: transfer.id } },
      { stripeAccount: w.destinationAccountId, idempotencyKey: `party-withdrawal-payout:${w.withdrawalId}:${w.amountCents}` },
    );
    payoutId = payout.id;
  } catch (e) {
    payoutError = e instanceof Error ? e.message : "The payout to your bank could not be started.";
    if (stripeFailureIsDefinitive(e)) {
      storedPayoutError = payoutError;
      await flag(db, "withdrawal_payout_refused", w.withdrawalId, { transfer: transfer.id, reason: payoutError });
    } else {
      // A 429 or a 5xx is not an answer: the row is marked so the sweep tries again rather than leaving the money
      // sitting in the recipient's Stripe balance with nothing watching it.
      storedPayoutError = payoutPendingVerificationMarker(0);
    }
  }
  // No payout was created and we never learned whether this account creates its own. The marker is what brings
  // `reconcileWithdrawals` back for it, and the flag makes it visible now.
  if (schedule === "unknown") await flag(db, "withdrawal_payout_schedule_unknown", w.withdrawalId, { transfer: transfer.id });
  const { data: done, error } = await db.rpc("complete_party_withdrawal", {
    p_id: w.withdrawalId, p_transfer: transfer.id, p_payout: payoutId, p_payout_error: storedPayoutError,
  });
  const d = done as { status?: string } | null;
  if (error || !d || (d.status !== "completed" && d.status !== "exists")) {
    // The transfer is real. Leave the reservation in place for reconciliation rather than reversing money that left.
    await db.rpc("mark_party_withdrawal_unknown", { p_id: w.withdrawalId });
    await flag(db, "withdrawal_not_recorded", w.withdrawalId, { transfer: transfer.id });
    return { ok: false, status: 503, code: "VERIFYING", error: "The withdrawal is being recorded. Do not submit it again." };
  }
  return {
    ok: true, withdrawalId: w.withdrawalId, transferId: transfer.id, payoutId, payoutPending: payoutId === null,
    ...(payoutError ? { payoutError } : {}), ...(payoutAutomatic ? { payoutAutomatic: true as const } : {}),
    ...(schedule === "unknown" ? { payoutScheduleUnknown: true as const } : {}),
  };
}

/** The connected account's payout schedule: `manual` (we create the payout), `automatic` (Stripe does), or `unknown` (read failed). */
export async function payoutScheduleOf(stripe: Stripe, accountId: string): Promise<"manual" | "automatic" | "unknown"> {
  try {
    const account = await stripe.accounts.retrieve(accountId);
    const interval = account.settings?.payouts?.schedule?.interval;
    if (interval === "manual") return "manual";
    return interval ? "automatic" : "unknown";
  } catch {
    return "unknown";
  }
}

async function flag(db: SupabaseClient, check: string, subject: string, detail: Record<string, unknown>): Promise<void> {
  await db.from("owner_ledger_flags").upsert({ check_name: check, subject, detail }, { onConflict: "check_name,subject,day", ignoreDuplicates: true }).then(undefined, () => undefined);
}

/**
 * Settle withdrawals a crash or timeout left in `reserved` / `unknown`. The transfer group names the withdrawal, so an
 * existing transfer is found by listing (never by retrying past Stripe's 24h idempotency window); only a young reservation with
 * no transfer is retried with its own key. Anything older with no transfer fails and releases the reservation.
 *
 * It also finishes the payouts that were never started - an unreadable schedule, or a payout Stripe could not take
 * right then. Those withdrawals are complete and the transfer landed, but on a manual-schedule account the money
 * would otherwise sit in the recipient's Stripe balance for ever.
 */
export async function reconcileWithdrawals(stripe: Stripe, db: SupabaseClient, now: Date = new Date()): Promise<{ completed: number; failed: number; retried: number; payoutsFinished: number }> {
  const { data, error } = await db
    .from("party_withdrawals")
    .select("id, party_kind, party_id, workspace_id, amount_cents, destination_account_id, status, created_at")
    .in("status", ["reserved", "unknown"])
    .lt("created_at", new Date(now.getTime() - 2 * 60_000).toISOString())
    .limit(100);
  if (error) {
    if (String(error.code) === "42P01" || String(error.code) === "PGRST205") return { completed: 0, failed: 0, retried: 0, payoutsFinished: 0 };
    throw new LedgerError(500, "Could not read withdrawals.");
  }
  let completed = 0, failed = 0, retried = 0;
  for (const raw of (data ?? []) as Array<Record<string, unknown>>) {
    const w: Carry = {
      withdrawalId: String(raw.id), amountCents: Number(raw.amount_cents), destinationAccountId: String(raw.destination_account_id),
      partyKind: raw.party_kind as "owner" | "vendor", partyId: String(raw.party_id), workspaceId: (raw.workspace_id as string | null) ?? null,
    };
    const found = await stripe.transfers.list({ transfer_group: `wd_${w.withdrawalId}`, limit: 10 });
    const match = found.data.find((t) => t.metadata?.withdrawal_id === w.withdrawalId && t.amount === w.amountCents && idOf(t.destination) === w.destinationAccountId);
    if (match) {
      // The transfer is real but nothing ever started its payout, so the row is completed WITH the marker and the
      // sweep below decides what that destination needs.
      const { data: done } = await db.rpc("complete_party_withdrawal", { p_id: w.withdrawalId, p_transfer: match.id, p_payout: null, p_payout_error: payoutPendingVerificationMarker(0) });
      if ((done as { status?: string } | null)?.status === "completed") completed += 1;
      continue;
    }
    if (found.data.length > 0) {
      // Money may have left under this group even though no transfer matches the reservation. Never release the reservation or
      // retry past it: a person decides.
      await db.rpc("mark_party_withdrawal_unknown", { p_id: w.withdrawalId });
      await flag(db, "withdrawal_transfer_mismatch", w.withdrawalId, { transfers: found.data.map((t) => t.id) });
      continue;
    }
    const ageMs = now.getTime() - Date.parse(String(raw.created_at));
    if (ageMs < RETRY_WINDOW_MS) {
      const result = await carryOutWithdrawal(stripe, db, w);
      if (result.ok) completed += 1;
      retried += 1;
    } else {
      await db.rpc("fail_party_withdrawal", { p_id: w.withdrawalId, p_reason: "No transfer was found at Stripe." });
      await flag(db, "withdrawal_expired", w.withdrawalId, {});
      failed += 1;
    }
  }
  return { completed, failed, retried, payoutsFinished: await finishPendingVerificationPayouts(stripe, db, now) };
}

/**
 * The payouts that are still owed: completed withdrawals with a transfer, no payout, and the pending-verification
 * marker on `payout_error`.
 *
 * Re-read the schedule - `manual` gets the payout now (the same per-withdrawal idempotency key, so a duplicate run
 * pays nobody twice), and `automatic` is Stripe's own job, which ends the sweep for that row. Everything that is not
 * an answer - an unreadable schedule, a 429, a 5xx - KEEPS the marker with its attempt count raised, because dropping
 * it would quietly strand the money: nothing else looks at a completed withdrawal. Only a definitive Stripe refusal
 * ends the sweep, and it raises a flag for a person. The attempt count also sets the back-off, so a destination that
 * keeps failing is tried on a widening interval instead of every hour.
 */
async function finishPendingVerificationPayouts(stripe: Stripe, db: SupabaseClient, now: Date): Promise<number> {
  const { data, error } = await db
    .from("party_withdrawals")
    .select("id, amount_cents, destination_account_id, stripe_transfer_id, payout_error, updated_at")
    .eq("status", "completed")
    .is("stripe_payout_id", null)
    .like("payout_error", `${PAYOUT_PENDING_VERIFICATION_CODE}%`)
    .limit(100);
  if (error) return 0;
  let finished = 0;
  for (const raw of (data ?? []) as Array<Record<string, unknown>>) {
    const pending = readPayoutPendingVerification(raw.payout_error);
    if (!pending) continue;
    const id = String(raw.id);
    const amountCents = Number(raw.amount_cents);
    const accountId = String(raw.destination_account_id ?? "");
    const transferId = String(raw.stripe_transfer_id ?? "");
    if (!accountId || !transferId || !Number.isFinite(amountCents) || amountCents <= 0) continue;
    const lastTouched = Date.parse(String(raw.updated_at ?? ""));
    const wait = Math.min(PAYOUT_RETRY_BASE_MS * 2 ** pending.attempts, PAYOUT_RETRY_MAX_MS);
    if (Number.isFinite(lastTouched) && now.getTime() - lastTouched < wait) continue;

    const keepTrying = async (attempts: number) => {
      await db.rpc("complete_party_withdrawal", {
        p_id: id, p_transfer: transferId, p_payout: null, p_payout_error: payoutPendingVerificationMarker(attempts),
      });
      if (attempts >= PAYOUT_RETRY_FLAG_AFTER) await flag(db, "withdrawal_payout_retrying", id, { attempts, account: accountId });
    };

    const schedule = await payoutScheduleOf(stripe, accountId);
    if (schedule === "unknown") {
      await keepTrying(pending.attempts + 1);
      continue;
    }
    if (schedule === "automatic") {
      await db.rpc("complete_party_withdrawal", {
        p_id: id, p_transfer: transferId, p_payout: null, p_payout_error: "It is on its way with the account's own automatic payout.",
      });
      finished += 1;
      continue;
    }
    // The create below is idempotent only for Stripe's 24 hours. A retry after that window (or one whose earlier
    // response was lost) would pay the same withdrawal twice, so the connected account's recent payouts are read
    // first and a payout already tagged with this withdrawal is adopted instead of created again. A list that cannot
    // be read is not an answer: keep the marker and try later rather than risk a second payout.
    let adopted: Stripe.Payout | null = null;
    try {
      const recent = await stripe.payouts.list({ limit: 100 }, { stripeAccount: accountId });
      adopted = (recent.data ?? []).find((p) => p.metadata?.withdrawal_id === id) ?? null;
    } catch {
      await keepTrying(pending.attempts + 1);
      continue;
    }
    if (adopted) {
      const status = String(adopted.status ?? "");
      // Only a payout that is on its way (or already there) ends this sweep. A `failed` or `canceled` payout put the
      // money back in the connected account's balance, and a withdrawal marked completed is never looked at again -
      // so the pending marker stays and a person is told, rather than the row reading paid with nothing moving.
      if (!PAYOUT_LIVE_STATUSES.has(status)) {
        await flag(db, "withdrawal_payout_not_live", id, {
          account: accountId,
          payout: adopted.id,
          status: status || "unknown",
          reason: adopted.failure_message ?? null,
        });
        await keepTrying(pending.attempts + 1);
        continue;
      }
      await db.rpc("complete_party_withdrawal", { p_id: id, p_transfer: transferId, p_payout: adopted.id, p_payout_error: null });
      finished += 1;
      continue;
    }
    try {
      const payout = await stripe.payouts.create(
        { amount: amountCents, currency: "usd", method: "standard", metadata: { withdrawal_id: id, transfer_id: transferId } },
        { stripeAccount: accountId, idempotencyKey: `party-withdrawal-payout:${id}:${amountCents}` },
      );
      // `complete_party_withdrawal` on an already-completed row fills the payout id and clears the error.
      await db.rpc("complete_party_withdrawal", { p_id: id, p_transfer: transferId, p_payout: payout.id, p_payout_error: null });
      finished += 1;
    } catch (e) {
      const reason = e instanceof Error ? e.message : "The payout to your bank could not be started.";
      if (!stripeFailureIsDefinitive(e)) {
        await keepTrying(pending.attempts + 1);
        continue;
      }
      await db.rpc("complete_party_withdrawal", { p_id: id, p_transfer: transferId, p_payout: null, p_payout_error: reason });
      await flag(db, "withdrawal_payout_refused", id, { account: accountId, reason });
    }
  }
  return finished;
}

/**
 * A payout whose money is on its way to the bank (or has arrived). Anything else - `failed`, `canceled`, or a status
 * Stripe adds later - is NOT an answer for a withdrawal: adopting it would close the row while the money sat back in
 * the connected account's balance.
 */
const PAYOUT_LIVE_STATUSES = new Set(["paid", "pending", "in_transit"]);

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
  // Paged: the cap was on LINES, not distinct vendors, so a vendor whose lines fell past it was never paid.
  const parties = new Set<string>();
  for (let page = 0; page < VENDOR_PARTY_MAX_PAGES; page += 1) {
    const { data, error } = await db
      .from("party_ledger_lines")
      .select("party_id, created_at")
      .eq("account", "vendor_payable")
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(page * VENDOR_PARTY_PAGE_SIZE, page * VENDOR_PARTY_PAGE_SIZE + VENDOR_PARTY_PAGE_SIZE - 1);
    if (error) {
      if (String(error.code) === "42P01" || String(error.code) === "PGRST205") return { paid: 0, skipped: 0, failed: 0 };
      throw new LedgerError(500, "Could not read vendor balances.");
    }
    const batch = (data ?? []) as Array<{ party_id: string | null }>;
    for (const row of batch) parties.add(row.party_id ?? "");
    if (batch.length < VENDOR_PARTY_PAGE_SIZE) break;
  }
  const vendors = [...parties].filter((p) => p.startsWith("vendor:"));
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
