import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { refundPaidHouseholdCharge } from "@/lib/household-charge-refund-rail.server";
import { getStripe } from "@/lib/stripe";
import { resolveManagerWorkspaceRowScope, rowInWorkspaceScope } from "@/lib/auth/co-manager-module-scope";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveTestWorkspaceClassification } from "@/lib/test-workspaces/index.server";

export const runtime = "nodejs";

/** One submission's own id, retained by the client across its retries of that submission. */
const OPERATION_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The reservation states the RPC can return. Anything else is not a reservation. */
const RESERVATION_STATES = ["reserved", "pending", "unknown", "succeeded", "failed", "reconciled"];

/** True only where the provider return is actually deployable for this actor. */
function depositReturnProviderEnabled(): boolean {
  return process.env.DEPOSIT_RETURN_PROVIDER_ENABLED === "true";
}

/**
 * Whether Return deposit can do anything at all right now, so the manager is not asked for an
 * amount and every deduction line before being refused.
 *
 * The answer is derived HERE, from the same deployment gate and the same test-identity
 * classification the POST applies — the client is told what it may offer, it never decides. It
 * names no charge and reads no row, so it is not an oracle for which deposits exist.
 */
export async function GET() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const db = createSupabaseServiceRoleClient();
  const classification = await resolveTestWorkspaceClassification(user.id, db).catch(() => null);
  const enabled = classification?.kind === "normal" && depositReturnProviderEnabled();
  return NextResponse.json({ enabled }, { headers: { "Cache-Control": "no-store" } });
}

/** Refuse provider returns until reservation and trust settlement are atomic. */
export async function POST(req: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

    const db = createSupabaseServiceRoleClient();
    // Deposits are real provider-backed funds. A durable test identity never
    // reaches charge/ledger reads or Stripe, regardless of workspace state.
    if ((await resolveTestWorkspaceClassification(user.id, db)).kind !== "normal") {
      return NextResponse.json({ error: "This action is unavailable." }, { status: 403 });
    }

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const chargeId = typeof body.chargeId === "string" ? body.chargeId.trim() : "";
    if (!chargeId) return NextResponse.json({ error: "chargeId is required." }, { status: 400 });

    const rawAmount = body.amountCents;
    if (rawAmount !== undefined && (typeof rawAmount !== "number" || !Number.isFinite(rawAmount))) {
      // A malformed amount is refused rather than dropped: silently returning the FULL deposit
      // because a number failed to parse is the worst possible reading of a bad request.
      return NextResponse.json({ error: "amountCents must be a number." }, { status: 400 });
    }

    const { data: row } = await db
      .from("portal_household_charge_records")
      .select("id, manager_user_id, property_id, status, row_data")
      .eq("id", chargeId)
      .maybeSingle();

    // A missing charge and someone else's charge answer identically, so this is not an oracle for
    // which charge ids exist.
    if (!row || String(row.manager_user_id ?? "") !== user.id) {
      return NextResponse.json({ error: "Deposit not found." }, { status: 404 });
    }

    // The charge reaches its house directly through its own `property_id`
    // column (the same column `portal-household-charges` scopes by), so no
    // join is needed here — only a single-row read of the column already on
    // this table. The active workspace still narrows: a manager's own
    // deposit outside it is refused exactly as if the charge were absent,
    // same 404 as above so this stays a non-oracle.
    const workspaceScope = await resolveManagerWorkspaceRowScope(db, user.id);
    if (!rowInWorkspaceScope(row.property_id ? String(row.property_id) : null, workspaceScope)) {
      return NextResponse.json({ error: "Deposit not found." }, { status: 404 });
    }

    // Deployment remains opt-in until the SQL reservation and settlement have
    // been exercised against the bounded dev/test database.
    if (!depositReturnProviderEnabled()) {
      return NextResponse.json({ error: "Deposit returns are unavailable while accounting is being reconciled.", status: "unavailable" }, { status: 503 });
    }
    const charge = (row.row_data ?? {}) as Record<string, unknown>;
    if (charge.kind !== "security_deposit" || row.status !== "paid" || ["pending", "processing"].includes(String(charge.stripePaymentStatus))) {
      return NextResponse.json({ error: "This deposit is not eligible for return." }, { status: 422 });
    }
    const amount = body.amountCents;
    const items = body.itemization;
    if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0 || !Array.isArray(items) || items.some((item) =>
      !item || typeof item !== "object" || typeof item.label !== "string" || !item.label.trim() ||
      !Number.isSafeInteger(item.amountCents) || item.amountCents <= 0)) {
      return NextResponse.json({ error: "Enter a valid return amount and itemization." }, { status: 400 });
    }
    const withhold = items.reduce((sum, item) => sum + item.amountCents, 0);
    if (!Number.isSafeInteger(withhold)) return NextResponse.json({ error: "Invalid deductions." }, { status: 400 });
    const { data: deposit, error: depositError } = await db.from("security_deposit_ledger").select("id,amount_held_cents,property_id")
      .eq("manager_user_id", user.id).eq("source_charge_id", chargeId).maybeSingle();
    const { data: payment, error: paymentError } = await db.from("ledger_entries").select("stripe_charge_id,amount_cents,property_id")
      .eq("source_charge_id", chargeId).eq("entry_type", "payment").maybeSingle();
    if (depositError || paymentError || !deposit || !payment || !payment.stripe_charge_id ||
        deposit.property_id !== row.property_id || payment.property_id !== row.property_id) {
      return NextResponse.json({ error: "Deposit accounting requires review." }, { status: 409 });
    }
    // The operation identity, not the amount. A key derived from charge + amount + deductions
    // would make two LEGITIMATE separate returns of the same figure collide; a fresh key on
    // every call makes the reservation's own replay branch unreachable, so a client timeout on a
    // submission that actually reserved comes back as a one-active-attempt refusal. So: one
    // explicit id per SUBMISSION, retained by the client across its own retries, and the RPC
    // compares the entire immutable basis before it returns the stored state.
    const operationId = typeof body.operationId === "string" && OPERATION_ID_SHAPE.test(body.operationId.trim())
      ? body.operationId.trim()
      : randomUUID();
    const { data: attempt, error: reserveError } = await db.rpc("reserve_security_deposit_return", {
      p_owner: user.id, p_deposit: deposit.id, p_charge: chargeId, p_request_key: operationId,
      p_expected_held: deposit.amount_held_cents, p_refund: amount, p_withhold: withhold, p_itemization: items,
    });
    if (reserveError || !attempt?.id) return NextResponse.json({ error: "Deposit return requires review before retrying." }, { status: 409 });
    // A replay of the SAME submission that already reached the provider: report what is stored.
    // Issuing a second provider call on an unknown or in-flight attempt is how one return
    // becomes two.
    const reservedStatus = typeof attempt.status === "string" ? attempt.status : "";
    if (!RESERVATION_STATES.includes(reservedStatus)) {
      return NextResponse.json({ error: "Deposit return requires review before retrying." }, { status: 409 });
    }
    if (attempt.provider_refund_id || reservedStatus !== "reserved") {
      return NextResponse.json({
        status: reservedStatus === "succeeded" || reservedStatus === "reconciled" ? "pending" : reservedStatus,
        refundId: attempt.provider_refund_id ?? null,
        ...(reservedStatus === "unknown" ? { error: "Return status requires reconciliation before retrying." } : {}),
      }, { status: 202 });
    }
    try {
      const refund = await refundPaidHouseholdCharge(getStripe(), db, {
        chargeId, stripeChargeId: payment.stripe_charge_id, amountCents: amount,
        idempotencyKey: `deposit-return:${attempt.id}`,
        metadata: { proplane_charge_id: chargeId, kind: "security_deposit_return", deposit_return_attempt: attempt.id },
      });
      // The webhook validates provider evidence and performs terminal accounting.
      // A lost stamp leaves the reservation active for reconciliation.
      const { error: stampError } = await db.from("security_deposit_return_attempts")
        .update({ provider_refund_id: refund.refundId || null, status: "unknown", updated_at: new Date().toISOString() })
        .eq("id", attempt.id).eq("status", "reserved");
      if (stampError) return NextResponse.json({ status: "unknown", error: "Return status requires reconciliation before retrying." }, { status: 202 });
      return NextResponse.json({ status: refund.status === "failed" ? "unknown" : "pending", refundId: refund.refundId }, { status: 202 });
    } catch {
      return NextResponse.json({ status: "unknown", error: "Return status requires reconciliation before retrying." }, { status: 202 });
    }

  } catch {
    return NextResponse.json({ error: "Could not return the deposit." }, { status: 500 });
  }
}
