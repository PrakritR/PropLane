import { NextResponse } from "next/server";
import { resolveManagerWorkspaceRowScope, rowInWorkspaceScope } from "@/lib/auth/co-manager-module-scope";
import { coManagerHasOwnerBankAccountAccess } from "@/lib/auth/manager-stripe-payout-access.server";
import { randomUUID } from "node:crypto";
import {
  decideChargeRefund,
  type ChargeRefundContext,
} from "@/lib/charge-refund";
import { runHouseholdChargeRefund } from "@/lib/household-charge-refund-coordinator.server";
import { getStripe } from "@/lib/stripe";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveChargePaidCents } from "@/lib/charge-paid-cents.server";
import { HouseholdChargeRefundReviewError } from "@/lib/household-charge-refund-rail.server";
import { resolveTestWorkspaceClassification } from "@/lib/test-workspaces/index.server";

export const runtime = "nodejs";

/** One submission's own id, retained by the client across its retries of that submission. */
const OPERATION_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Refund a paid rent or fee charge (C023) — the general counterpart to Return deposit for
 * everything a security deposit is not.
 *
 * Same shape and the same two deliberate omissions as `deposit-return/route.ts`:
 *
 * The ledger is not written here — `charge.refunded` already books the refund through
 * `handleStripeRefund` in the financial webhook, and writing it here too would double-count.
 *
 * It trusts the client for nothing but the charge id and an optional amount. Ownership, the
 * amount already refunded, and the Stripe charge to refund against are all re-read server-side.
 *
 * C100 (who may issue a refund): the charge's OWNER always may. A co-manager may only when they
 * hold the `bankAccount` ("Bank account & payouts") grant at `edit` under that owner — the same
 * gate `resolveStripePayoutContext` uses for the owner's Stripe payout state, so "can see/change
 * the bank account" and "can move money out of a paid charge" stay the same permission.
 */
export async function POST(req: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

    const db = createSupabaseServiceRoleClient();
    // Refunds are real provider-backed funds. A durable test identity never reaches charge/ledger
    // reads or Stripe, regardless of workspace state.
    if ((await resolveTestWorkspaceClassification(user.id, db)).kind !== "normal") {
      return NextResponse.json({ error: "This action is unavailable." }, { status: 403 });
    }

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const chargeId = typeof body.chargeId === "string" ? body.chargeId.trim() : "";
    if (!chargeId) return NextResponse.json({ error: "chargeId is required." }, { status: 400 });

    const rawAmount = body.amountCents;
    if (rawAmount !== undefined && (typeof rawAmount !== "number" || !Number.isFinite(rawAmount))) {
      // A malformed amount is refused rather than dropped: silently refunding the FULL charge
      // because a number failed to parse is the worst possible reading of a bad request.
      return NextResponse.json({ error: "amountCents must be a number." }, { status: 400 });
    }

    const { data: row } = await db
      .from("portal_household_charge_records")
      .select("id, manager_user_id, property_id, status, row_data")
      .eq("id", chargeId)
      .maybeSingle();

    // A missing charge and someone else's charge (with no refund access) answer identically, so
    // this is not an oracle for which charge ids exist.
    const notFound = () => NextResponse.json({ error: "Charge not found." }, { status: 404 });
    if (!row) return notFound();

    const ownerUserId = String(row.manager_user_id ?? "");
    if (ownerUserId !== user.id) {
      const allowed = ownerUserId
        ? await coManagerHasOwnerBankAccountAccess(db, user.id, ownerUserId, "edit")
        : false;
      if (!allowed) return notFound();
    }

    // Same workspace-scope narrowing as deposit-return: a manager's own charge outside the
    // active workspace is refused exactly as if it were absent.
    const workspaceScope = await resolveManagerWorkspaceRowScope(db, user.id);
    if (!rowInWorkspaceScope(row.property_id ? String(row.property_id) : null, workspaceScope)) {
      return notFound();
    }

    const charge = (row.row_data ?? {}) as Record<string, unknown>;

    // The Stripe charge the money arrived on, taken from the ledger's payment entry — the same
    // record the refund webhook keys on — rather than from the charge row itself.
    const { data: payment, error: paymentError } = await db
      .from("ledger_entries")
      .select("stripe_charge_id, amount_cents")
      .eq("source_charge_id", chargeId)
      .eq("entry_type", "payment")
      .maybeSingle();

    if (paymentError) return NextResponse.json({ error: "Could not verify the payment ledger." }, { status: 500 });

    const ctx: ChargeRefundContext = {
      kind: String(charge.kind ?? ""),
      status: String(row.status ?? charge.status ?? ""),
      paidCents: resolveChargePaidCents(payment?.amount_cents, charge),
      alreadyRefundedCents: Number(charge.refundedCents ?? 0),
      stripeChargeId: (payment?.stripe_charge_id as string | null) ?? null,
      // An ACH debit can bounce after it looks paid; only a settled payment may be refunded.
      settled: charge.stripePaymentStatus !== "processing" && charge.stripePaymentStatus !== "pending",
    };

    const decision = decideChargeRefund(ctx, rawAmount as number | undefined);
    if (!decision.ok) {
      return NextResponse.json({ error: decision.message, reason: decision.reason }, { status: 422 });
    }

    // The operation identity, not the amount: a key built from charge + amount would make two
    // LEGITIMATE separate refunds of the same figure collide, and a fresh key on every call
    // makes the reservation's own replay branch unreachable. One id per submission, retained by
    // the client across its retries of that submission.
    const operationKey = typeof body.operationId === "string" && OPERATION_ID_SHAPE.test(body.operationId.trim())
      ? body.operationId.trim()
      : randomUUID();

    // One durable coordinator for every initiator: the budget is reserved against the payment
    // ledger under the charge's row lock and acknowledged before the provider is called, the
    // provider idempotency key is the reserved attempt's own id, and the money is projected onto
    // the charge by the refund webhook from re-read terminal evidence. Nothing here writes
    // `refundedCents`, because a provider `succeeded` is not yet verified terminal accounting.
    let outcome: Awaited<ReturnType<typeof runHouseholdChargeRefund>>;
    try {
      outcome = await runHouseholdChargeRefund(getStripe(), db, {
        ownerUserId,
        chargeId,
        stripeChargeId: decision.stripeChargeId,
        paymentIntentId: null,
        amountCents: decision.amountCents,
        operationKey,
        basis: {
          kind: "charge_refund",
          actorUserId: user.id,
          chargeKind: ctx.kind,
          paidCents: ctx.paidCents,
          baselineRefundedCents: ctx.alreadyRefundedCents,
          stripeChargeId: decision.stripeChargeId,
        },
        metadata: { proplane_charge_id: chargeId, kind: "charge_refund" },
      });
    } catch {
      // The reservation is already recorded uncertain. Nothing about the provider's own message
      // reaches the client.
      return NextResponse.json({ status: "unknown", error: "Refund status requires reconciliation before retrying." }, { status: 202 });
    }

    if (outcome.kind === "review") {
      return NextResponse.json({ error: outcome.message }, { status: 409 });
    }
    if (outcome.kind === "unknown") {
      return NextResponse.json({ status: "unknown", error: outcome.message, refundId: outcome.refundId }, { status: 202 });
    }
    return NextResponse.json({
      status: "pending",
      refundId: outcome.refundId,
      amountCents: decision.amountCents,
      remainingCents: decision.remainingAfterCents,
    }, { status: 202 });
  } catch (error) {
    if (error instanceof HouseholdChargeRefundReviewError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "Could not refund this charge." }, { status: 500 });
  }
}
