import { NextResponse } from "next/server";
import {
  decideDepositReturn,
  depositReturnIdempotencyKey,
  type DepositReturnContext,
} from "@/lib/deposit-return";
import { getStripe } from "@/lib/stripe";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/**
 * Return a security deposit to the resident who paid it.
 *
 * The manager presses one button; money leaves their balance and goes back to the resident's
 * original payment method. Stripe will not un-refund, so the decision of whether and how much
 * lives in `deposit-return.ts` and is made before anything is called.
 *
 * Two things this route does NOT do, on purpose:
 *
 * The ledger is not written here. `charge.refunded` already reverses the deposit liability
 * through the financial webhook, and writing it here too would double-count every return — the
 * webhook fires whether the refund came from this button or from the Stripe dashboard, so it is
 * the one place that can be correct for both.
 *
 * It does not trust the client for anything but the charge id and an optional amount. Ownership,
 * the amount already returned, and the Stripe charge to refund against are all re-read server-side
 * from the record, because every one of them decides how much money moves.
 */
export async function POST(req: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const chargeId = typeof body.chargeId === "string" ? body.chargeId.trim() : "";
    if (!chargeId) return NextResponse.json({ error: "chargeId is required." }, { status: 400 });

    const rawAmount = body.amountCents;
    if (rawAmount !== undefined && (typeof rawAmount !== "number" || !Number.isFinite(rawAmount))) {
      // A malformed amount is refused rather than dropped: silently returning the FULL deposit
      // because a number failed to parse is the worst possible reading of a bad request.
      return NextResponse.json({ error: "amountCents must be a number." }, { status: 400 });
    }

    const db = createSupabaseServiceRoleClient();
    const { data: row } = await db
      .from("portal_household_charge_records")
      .select("id, manager_user_id, status, row_data")
      .eq("id", chargeId)
      .maybeSingle();

    // A missing charge and someone else's charge answer identically, so this is not an oracle for
    // which charge ids exist.
    if (!row || String(row.manager_user_id ?? "") !== user.id) {
      return NextResponse.json({ error: "Deposit not found." }, { status: 404 });
    }

    const charge = (row.row_data ?? {}) as Record<string, unknown>;

    // The Stripe charge the money arrived on, taken from the ledger's payment entry rather than
    // from the record — the ledger is what the refund webhook keys on, so a refund issued against
    // anything else could not be reconciled back.
    const { data: payment } = await db
      .from("ledger_entries")
      .select("stripe_charge_id")
      .eq("source_charge_id", chargeId)
      .eq("entry_type", "payment")
      .maybeSingle();

    const ctx: DepositReturnContext = {
      kind: String(charge.kind ?? ""),
      status: String(row.status ?? charge.status ?? ""),
      paidCents: Number(charge.paidCents ?? charge.amountCents ?? 0),
      alreadyReturnedCents: Number(charge.depositReturnedCents ?? 0),
      stripeChargeId: (payment?.stripe_charge_id as string | null) ?? null,
      // An ACH debit can bounce after it looks paid; only a settled payment may be sent back.
      settled: charge.stripePaymentStatus !== "processing" && charge.stripePaymentStatus !== "pending",
    };

    const decision = decideDepositReturn(ctx, rawAmount as number | undefined);
    if (!decision.ok) {
      return NextResponse.json({ error: decision.message, reason: decision.reason }, { status: 422 });
    }

    const attempt = Number(charge.depositReturnAttempts ?? 0) + 1;
    const stripe = getStripe();
    const refund = await stripe.refunds.create(
      {
        charge: decision.stripeChargeId,
        amount: decision.amountCents,
        // The deposit was collected as a destination charge into the manager's connected account,
        // so the transfer must be reversed too. Without this the money comes out of PropLane's
        // platform balance and the manager silently keeps a deposit they no longer hold.
        reverse_transfer: true,
        metadata: { proplane_charge_id: chargeId, kind: "security_deposit_return" },
      },
      // Two clicks, or a retry after a timeout that actually succeeded, must not send it twice.
      { idempotencyKey: depositReturnIdempotencyKey({ chargeId, amountCents: decision.amountCents, attempt }) },
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
          depositReturnedCents: ctx.alreadyReturnedCents + decision.amountCents,
          depositReturnAttempts: attempt,
          depositLastReturnedAt: now,
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
    return NextResponse.json({ error: "Could not return the deposit." }, { status: 500 });
  }
}
