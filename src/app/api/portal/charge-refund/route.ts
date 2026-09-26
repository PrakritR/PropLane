import { NextResponse } from "next/server";
import { resolveManagerWorkspaceRowScope, rowInWorkspaceScope } from "@/lib/auth/co-manager-module-scope";
import { coManagerHasOwnerBankAccountAccess } from "@/lib/auth/manager-stripe-payout-access.server";
import {
  chargeRefundIdempotencyKey,
  decideChargeRefund,
  type ChargeRefundContext,
} from "@/lib/charge-refund";
import { getStripe } from "@/lib/stripe";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveTestWorkspaceClassification } from "@/lib/test-workspaces/index.server";

export const runtime = "nodejs";

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
    const workspaceScope = await resolveManagerWorkspaceRowScope(db, ownerUserId || user.id);
    if (!rowInWorkspaceScope(row.property_id ? String(row.property_id) : null, workspaceScope)) {
      return notFound();
    }

    const charge = (row.row_data ?? {}) as Record<string, unknown>;

    // The Stripe charge the money arrived on, taken from the ledger's payment entry — the same
    // record the refund webhook keys on — rather than from the charge row itself.
    const { data: payment } = await db
      .from("ledger_entries")
      .select("stripe_charge_id")
      .eq("source_charge_id", chargeId)
      .eq("entry_type", "payment")
      .maybeSingle();

    const ctx: ChargeRefundContext = {
      kind: String(charge.kind ?? ""),
      status: String(row.status ?? charge.status ?? ""),
      paidCents: Number(charge.paidCents ?? charge.amountCents ?? 0),
      alreadyRefundedCents: Number(charge.refundedCents ?? 0),
      stripeChargeId: (payment?.stripe_charge_id as string | null) ?? null,
      // An ACH debit can bounce after it looks paid; only a settled payment may be refunded.
      settled: charge.stripePaymentStatus !== "processing" && charge.stripePaymentStatus !== "pending",
    };

    const decision = decideChargeRefund(ctx, rawAmount as number | undefined);
    if (!decision.ok) {
      return NextResponse.json({ error: decision.message, reason: decision.reason }, { status: 422 });
    }

    const attempt = Number(charge.refundAttempts ?? 0) + 1;
    const stripe = getStripe();
    const refund = await stripe.refunds.create(
      {
        charge: decision.stripeChargeId,
        amount: decision.amountCents,
        // Collected as a destination charge into the manager's connected account, so the
        // transfer must be reversed too, or the refund comes out of PropLane's platform balance
        // while the manager silently keeps money they no longer hold.
        reverse_transfer: true,
        metadata: { proplane_charge_id: chargeId, kind: "charge_refund" },
      },
      // Two clicks, or a retry after a timeout that actually succeeded, must not send it twice.
      { idempotencyKey: chargeRefundIdempotencyKey({ chargeId, amountCents: decision.amountCents, attempt }) },
    );

    const now = new Date().toISOString();
    await db.from("portal_household_charge_records").upsert(
      {
        id: chargeId,
        manager_user_id: row.manager_user_id,
        resident_email: String(charge.residentEmail ?? "").trim().toLowerCase(),
        status: row.status,
        row_data: {
          ...charge,
          refundedCents: ctx.alreadyRefundedCents + decision.amountCents,
          refundAttempts: attempt,
          lastRefundedAt: now,
        },
        updated_at: now,
      },
      { onConflict: "id" },
    );

    return NextResponse.json({
      ok: true,
      refundId: refund.id,
      amountCents: decision.amountCents,
      remainingCents: decision.remainingAfterCents,
    });
  } catch {
    return NextResponse.json({ error: "Could not refund this charge." }, { status: 500 });
  }
}
