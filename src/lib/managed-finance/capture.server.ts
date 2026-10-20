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

  // One leasing fee per resident per policy, on the first leasing-kind charge only.
  const leasingEligible = new Set<string>();
  const emailsSeen = new Set<string>();
  if (policy.terms.leasingFeeBps > 0) {
    const emails = [...new Set(applicable.filter((c) => isLeasingFeeKind(c.kind) && c.residentEmail).map((c) => c.residentEmail.toLowerCase()))];
    const { data: prior, error: priorError } = emails.length
      ? await db.from("managed_rent_allocations").select("resident_email").eq("policy_id", policy.id).gt("leasing_cents", 0).in("resident_email", emails)
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

  for (let attempt = 0; attempt < CONFLICT_RETRIES; attempt += 1) {
    const { data: totalsData, error: totalsError } = await db.rpc("managed_month_totals", { p_policy: policy.id, p_month: monthKey });
    const totals = (Array.isArray(totalsData) ? totalsData[0] : totalsData) as Totals | null;
    if (totalsError || !totals) throw new LedgerError(500, "Could not read the month's collected rent.");
    const cum = Number(totals.cum_base);
    const taken = Number(totals.monthly_fee);
    const cart = computeCartFee({ terms: policy.terms, cumBaseBefore: cum, monthlyFeeTakenBefore: taken, applicableBase, leasingBase });
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
      p_key: `capture:${input.paymentIntentId}`,
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
