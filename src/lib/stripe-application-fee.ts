import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { APPLICATION_FEE_CHECKOUT_PURPOSE, axisAchCheckoutPaid } from "@/lib/stripe-axis-ach-checkout";
import type { HouseholdCharge } from "@/lib/household-charges";
import { cancelFuturePaymentRemindersForCharge } from "@/lib/payment-reminder-lifecycle.server";
import { syncLedgerPaymentEntry } from "@/lib/reports/ledger-sync";

export function includesHoldingDeposit(session: Stripe.Checkout.Session): boolean {
  return session.metadata?.includes_holding_deposit === "true";
}

export function isApplicationFeeCheckoutSession(session: Stripe.Checkout.Session): boolean {
  return session.metadata?.purpose === APPLICATION_FEE_CHECKOUT_PURPOSE;
}

/**
 * Marks the pending application-fee household charge paid after Stripe ACH clears.
 */
export async function markApplicationFeePaidFromStripeSession(
  db: SupabaseClient,
  session: Stripe.Checkout.Session,
): Promise<{ ok: boolean; chargeId?: string; alreadyPaid?: boolean }> {
  if (!isApplicationFeeCheckoutSession(session) || !axisAchCheckoutPaid(session)) {
    return { ok: false };
  }

  const propertyId = session.metadata?.property_id?.trim();
  const residentEmail =
    session.metadata?.resident_email?.trim().toLowerCase() ??
    session.customer_email?.trim().toLowerCase() ??
    "";
  if (!propertyId || !residentEmail.includes("@")) return { ok: false };

  const { data: rows, error } = await db
    .from("portal_household_charge_records")
    .select("id, row_data, status")
    .eq("resident_email", residentEmail);

  if (error || !rows?.length) return { ok: false };

  const candidates = rows.filter((row) => {
    const charge = row.row_data as HouseholdCharge | null;
    if (!charge || charge.kind !== "application_fee") return false;
    return charge.propertyId === propertyId;
  });

  const match =
    candidates.find((row) => row.status === "pending") ??
    candidates.find((row) => {
      const charge = row.row_data as HouseholdCharge;
      return row.status === "paid" || charge.status === "paid";
    });

  if (!match) return { ok: false };

  const charge = match.row_data as HouseholdCharge;
  if (match.status === "paid" || charge.status === "paid") {
    await syncLedgerPaymentEntry(db, charge, charge.paidAt, session.id).catch((err) => {
      console.error("[stripe-application-fee] ledger heal for already-paid charge failed", err);
    });
    return { ok: true, chargeId: match.id as string, alreadyPaid: true };
  }

  const now = new Date().toISOString();
  const nextCharge: HouseholdCharge = {
    ...charge,
    status: "paid",
    paidAt: now,
    balanceLabel: "$0.00",
  };

  const { error: upsertErr } = await db.from("portal_household_charge_records").upsert(
    {
      id: match.id,
      manager_user_id: charge.managerUserId,
      resident_user_id: charge.residentUserId,
      resident_email: residentEmail,
      property_id: propertyId,
      kind: "application_fee",
      status: "paid",
      row_data: {
        ...nextCharge,
        stripeCheckoutSessionId: session.id,
        stripePaymentStatus: session.payment_status,
      },
      updated_at: now,
    },
    { onConflict: "id" },
  );

  if (upsertErr) return { ok: false };
  await syncLedgerPaymentEntry(db, nextCharge, now, session.id);
  if (charge.managerUserId) {
    await cancelFuturePaymentRemindersForCharge(db, charge.managerUserId, match.id as string).catch(() => undefined);
  }
  return { ok: true, chargeId: match.id as string };
}

/**
 * Marks the pending holding-deposit household charge paid alongside the
 * application fee, when this session combined both into one Checkout
 * (`metadata.includes_holding_deposit`). Nothing creates combined sessions
 * anymore — the application collects only the fee, so this survives solely to
 * settle legacy in-flight sessions and is a no-op on any session without that
 * metadata (i.e. every new session), making it always safe to call
 * unconditionally after `markApplicationFeePaidFromStripeSession`.
 */
export async function markApplicationDepositPaidFromStripeSession(
  db: SupabaseClient,
  session: Stripe.Checkout.Session,
): Promise<{ ok: boolean; chargeId?: string; alreadyPaid?: boolean }> {
  if (!isApplicationFeeCheckoutSession(session) || !includesHoldingDeposit(session) || !axisAchCheckoutPaid(session)) {
    return { ok: false };
  }

  const propertyId = session.metadata?.property_id?.trim();
  const residentEmail =
    session.metadata?.resident_email?.trim().toLowerCase() ??
    session.customer_email?.trim().toLowerCase() ??
    "";
  if (!propertyId || !residentEmail.includes("@")) return { ok: false };

  const { data: rows, error } = await db
    .from("portal_household_charge_records")
    .select("id, row_data, status")
    .eq("resident_email", residentEmail);

  if (error || !rows?.length) return { ok: false };

  const candidates = rows.filter((row) => {
    const charge = row.row_data as HouseholdCharge | null;
    if (!charge || charge.kind !== "holding_deposit") return false;
    return charge.propertyId === propertyId;
  });

  const match =
    candidates.find((row) => row.status === "pending") ??
    candidates.find((row) => {
      const charge = row.row_data as HouseholdCharge;
      return row.status === "paid" || charge.status === "paid";
    });

  if (!match) return { ok: false };

  const charge = match.row_data as HouseholdCharge;
  if (match.status === "paid" || charge.status === "paid") {
    // `holding_deposit` maps to the `security_deposit_liability` GL category
    // (`categoryCodeForChargeKind`) exactly like `security_deposit`, so this
    // needs the same healing-sync call the fee side makes for an already-paid
    // charge — the ledger is write-through, never read-time backfill.
    await syncLedgerPaymentEntry(db, charge, charge.paidAt, session.id).catch((err) => {
      console.error("[stripe-application-fee] ledger heal for already-paid deposit charge failed", err);
    });
    return { ok: true, chargeId: match.id as string, alreadyPaid: true };
  }

  const now = new Date().toISOString();
  const nextCharge: HouseholdCharge = {
    ...charge,
    status: "paid",
    paidAt: now,
    balanceLabel: "$0.00",
  };

  const { error: upsertErr } = await db.from("portal_household_charge_records").upsert(
    {
      id: match.id,
      manager_user_id: charge.managerUserId,
      resident_user_id: charge.residentUserId,
      resident_email: residentEmail,
      property_id: propertyId,
      kind: "holding_deposit",
      status: "paid",
      row_data: {
        ...nextCharge,
        stripeCheckoutSessionId: session.id,
        stripePaymentStatus: session.payment_status,
      },
      updated_at: now,
    },
    { onConflict: "id" },
  );

  if (upsertErr) return { ok: false };
  await syncLedgerPaymentEntry(db, nextCharge, now, session.id);
  if (charge.managerUserId) {
    await cancelFuturePaymentRemindersForCharge(db, charge.managerUserId, match.id as string).catch(() => undefined);
  }
  return { ok: true, chargeId: match.id as string };
}
