import "server-only";

import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computeCartFee,
  feeAppliesToKind,
  isLeasingFeeKind,
  pacificMonthKey,
  spreadByWeight,
  splitManagedCart,
  type CartComponent,
} from "@/lib/owner-management/fee-math";
import type { PolicyRow } from "@/lib/owner-management/policies.server";
import { verifiedCapturedChargeAvailability } from "@/lib/platform-owner-recovery.server";
import { LedgerError } from "@/lib/managed-finance/ledger.server";

/**
 * Allocate one verified platform capture of a managed workspace's resident payment to owner / PropLane / deposits. The
 * capture itself is verified by the caller (the same checks the hold path runs); this writes the balanced journal and the
 * per-charge split atomically, once per PaymentIntent. Nothing is credited to a manager hold.
 */

export type ManagedCaptureComponent = {
  id: string;
  kind: string;
  liabilityClass: "income" | "deposit";
  principalCents: number;
  /** principal less any processing fee the owner side bears (the frozen per-charge recipient net). */
  recipientNetCents: number;
  propertyId: string | null;
  residentEmail: string;
  paidAt: string;
};

export type ManagedCaptureInput = {
  policy: PolicyRow;
  paymentIntentId: string;
  stripeChargeId: string;
  grossCents: number;
  components: ManagedCaptureComponent[];
};

const CONFLICT_RETRIES = 4;

/**
 * The monthly fee EVERY OTHER version of this workspace already took this Pacific month. `managed_month_totals` is
 * scoped to one `policy_id` - which is what keeps a rate change off rent already collected - so the monthly minimum
 * has to be counted across versions here, or an admin changing the rate mid-month charges that floor a second time.
 */
async function monthFeeTakenByOtherVersions(db: SupabaseClient, policy: PolicyRow, monthKey: string): Promise<number> {
  const { data, error } = await db
    .from("managed_rent_allocations")
    .select("policy_id, fee_cents, refunded_fee_cents")
    .eq("workspace_id", policy.workspaceId)
    .eq("month_key", monthKey)
    .eq("fee_applies", true);
  if (error) throw new LedgerError(500, "Could not read the month's management fee.");
  const rows = (data ?? []) as Array<{ policy_id: string | null; fee_cents: number; refunded_fee_cents: number }>;
  return rows
    .filter((r) => String(r.policy_id ?? "") !== policy.id)
    .reduce((sum, r) => sum + Math.max(Number(r.fee_cents) - Number(r.refunded_fee_cents), 0), 0);
}

/** The journal key one managed capture is idempotent on. */
export function managedCaptureKey(paymentIntentId: string): string {
  return `capture:${paymentIntentId}`;
}

/**
 * Has this PaymentIntent already been allocated on the party ledger?
 *
 * The "managed or hold" deciders resolve the workspace's managed status at the moment the webhook runs, so a policy
 * that ended between a first delivery and its retry would answer "not managed" and send the SAME money down the
 * manager-hold path - paying the owner on the ledger AND crediting the manager's hold. The journal is the record of
 * what was actually done, so it is asked first. Throws on a failed read: a decider that cannot tell must not credit
 * a hold.
 */
export async function managedCaptureExistsForPaymentIntent(db: SupabaseClient, paymentIntentId: string): Promise<boolean> {
  const pi = paymentIntentId.trim();
  if (!pi) return false;
  const { data, error } = await db
    .from("party_ledger_journals")
    .select("id")
    .eq("idempotency_key", managedCaptureKey(pi))
    .limit(1);
  if (error) throw new LedgerError(500, "Could not read the payment allocation.");
  return ((data ?? []) as unknown[]).length > 0;
}

type Totals = { cum_base: number | string; monthly_fee: number | string };

export async function creditManagedCapture(
  db: SupabaseClient,
  stripe: Stripe,
  input: ManagedCaptureInput,
): Promise<{ status: "created" | "exists"; journalId: string }> {
  const { policy } = input;
  if (policy.status !== "active" || !policy.signedAt) throw new LedgerError(409, "This workspace has no accepted fee policy.");
  if (!input.components.length) throw new LedgerError(500, "A managed capture needs charges.");
  const principal = input.components.reduce((s, c) => s + c.principalCents, 0);
  const distributable = input.components.reduce((s, c) => s + c.recipientNetCents, 0);
  // Gross above principal is the processing fee the resident added at checkout. It can never be more than the
  // principal itself, and a capture that claims it is cannot be refunded in full later, so it is refused here.
  const residentAdded = input.grossCents - principal;
  if (
    !Number.isSafeInteger(input.grossCents) || input.grossCents < principal || distributable > principal ||
    distributable <= 0 || residentAdded > principal
  ) {
    throw new LedgerError(500, "Managed capture amounts do not reconcile.");
  }

  const charge = await stripe.charges.retrieve(input.stripeChargeId);
  if (charge.id !== input.stripeChargeId || charge.amount !== input.grossCents) {
    throw new LedgerError(500, "Managed capture differs from its Stripe Charge.");
  }
  const availability = await verifiedCapturedChargeAvailability(stripe, charge);
  const availableOn = availability?.availableOn ?? null;
  const paidAt = input.components.map((c) => c.paidAt).sort()[0]!;
  const monthKey = pacificMonthKey(paidAt);

  const comps: CartComponent[] = input.components.map((c) => ({
    id: c.id, kind: c.kind, liabilityClass: c.liabilityClass, principalCents: c.principalCents,
    distributableCents: c.recipientNetCents, residentEmail: c.residentEmail,
  }));
  const applicable = comps.filter((c) => c.liabilityClass === "income" && feeAppliesToKind(policy.terms, c.kind));
  const applicableBase = applicable.reduce((s, c) => s + c.distributableCents, 0);

  // One leasing fee per resident per WORKSPACE, on the first leasing-kind charge only: a rate change makes a new policy
  // version, and the resident must not be charged a second leasing fee because the row carries a new `policy_id`.
  const leasingEligible = new Set<string>();
  const emailsSeen = new Set<string>();
  if (policy.terms.leasingFeeBps > 0) {
    const emails = [...new Set(applicable.filter((c) => isLeasingFeeKind(c.kind) && c.residentEmail).map((c) => c.residentEmail.toLowerCase()))];
    const { data: prior, error: priorError } = emails.length
      ? await db.from("managed_rent_allocations").select("resident_email").eq("workspace_id", policy.workspaceId).gt("leasing_cents", 0).in("resident_email", emails)
      : { data: [], error: null };
    if (priorError) throw new LedgerError(500, "Could not read leasing fee history.");
    const charged = new Set(((prior ?? []) as Array<{ resident_email: string }>).map((r) => r.resident_email.toLowerCase()));
    for (const c of [...applicable].sort((a, b) => a.id.localeCompare(b.id))) {
      const email = c.residentEmail.toLowerCase();
      if (!isLeasingFeeKind(c.kind) || !email || charged.has(email) || emailsSeen.has(email)) continue;
      emailsSeen.add(email);
      leasingEligible.add(c.id);
    }
  }
  const leasingBase = applicable.filter((c) => leasingEligible.has(c.id)).reduce((s, c) => s + c.distributableCents, 0);

  // The resident-added fee is recorded PER charge so that a full Stripe refund (which returns the gross, not the
  // principal) can be reversed in the ledger instead of being refused for exceeding the allocation's principal.
  const addedByCharge = new Map<string, number>(
    residentAdded > 0
      ? spreadByWeight(comps.map((c) => ({ id: c.id, weight: c.principalCents })), residentAdded).map((p) => [p.id, p.cents])
      : [],
  );

  // The monthly minimum is the workspace's for the month, not each version's: what an earlier version already took
  // this month pays it down (`targetMonthlyFeeCents`), so a mid-month rate change never charges the floor twice.
  const priorVersionFeeCents = policy.terms.minFeeCents > 0 ? await monthFeeTakenByOtherVersions(db, policy, monthKey) : 0;

  for (let attempt = 0; attempt < CONFLICT_RETRIES; attempt += 1) {
    const { data: totalsData, error: totalsError } = await db.rpc("managed_month_totals", { p_policy: policy.id, p_month: monthKey });
    const totals = (Array.isArray(totalsData) ? totalsData[0] : totalsData) as Totals | null;
    if (totalsError || !totals) throw new LedgerError(500, "Could not read the month's collected rent.");
    const cum = Number(totals.cum_base);
    const taken = Number(totals.monthly_fee);
    const cart = computeCartFee({ terms: policy.terms, cumBaseBefore: cum, monthlyFeeTakenBefore: taken, applicableBase, leasingBase, priorVersionFeeCents });
    const split = splitManagedCart(policy.terms, comps, cart, leasingEligible);
    const rows = split.map((s) => {
      const source = input.components.find((c) => c.id === s.id)!;
      return {
        charge_id: s.id,
        charge_kind: s.kind,
        liability_class: s.liabilityClass,
        fee_applies: s.feeApplies,
        resident_email: s.residentEmail,
        property_id: source.propertyId ?? "",
        principal_cents: s.principalCents,
        resident_added_cents: addedByCharge.get(s.id) ?? 0,
        owner_borne_cents: s.ownerBornCents,
        distributable_cents: s.distributableCents,
        fee_cents: s.feeCents,
        leasing_cents: s.leasingCents,
        owner_cents: s.ownerCents,
        deposit_cents: s.depositCents,
        paid_at: source.paidAt,
      };
    });
    const { data, error } = await db.rpc("credit_managed_capture", {
      p_policy: policy.id,
      p_workspace: policy.workspaceId,
      p_key: managedCaptureKey(input.paymentIntentId),
      p_pi: input.paymentIntentId,
      p_stripe_charge: input.stripeChargeId,
      p_month: monthKey,
      p_available_on: availableOn,
      p_gross: input.grossCents,
      p_expect_base: cum,
      p_expect_fee: taken,
      p_rows: rows,
    });
    const result = data as { status?: string; reason?: string; journal_id?: string } | null;
    if (error || !result) throw new LedgerError(500, "Could not allocate the payment.");
    if (result.status === "conflict") continue;
    if (result.status === "created" || result.status === "exists") {
      return { status: result.status, journalId: String(result.journal_id) };
    }
    throw new LedgerError(409, `The payment could not be allocated (${result.reason ?? "refused"}).`, result.reason);
  }
  throw new LedgerError(409, "Another payment for this workspace was recording at the same time. It will be retried.", "busy");
}
