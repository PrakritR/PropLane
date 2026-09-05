import type { SupabaseClient } from "@supabase/supabase-js";
import type { HouseholdCharge } from "@/lib/household-charges";
import { listingFromPropertyData } from "@/lib/household-charge-payment-eligibility";
import { resolveListingForHouseholdCharge } from "@/lib/household-charge-payment-eligibility.server";
import { normalizeManagerSkuTier } from "@/lib/manager-access";
import { getManagerPurchaseSku } from "@/lib/manager-access-server";
import { loadManagerManualPaymentSettings } from "@/lib/manager-manual-payment-settings";
import {
  axisPaymentsEnabledOnListing,
  resolveServiceFeePayerFor,
  type ResidentAxisPaymentMethod,
} from "@/lib/payment-policy";
import { getStripe } from "@/lib/stripe";
import { createAxisAchCheckoutSession, stripeNotConfiguredError } from "@/lib/stripe-axis-ach-checkout";
import {
  isStripeConnectAccountAccessError,
  managerConnectReconnectMessage,
  resolveAndValidateManagerConnectForPayments,
} from "@/lib/stripe-connect";
import { householdChargeAmountCents, HOUSEHOLD_CHARGE_CHECKOUT_PURPOSE } from "@/lib/stripe-household-charge";

/**
 * The Stripe Checkout core for paying pending household charges, extracted from
 * `/api/stripe/household-charge-checkout` so the resident agent's
 * start_rent_payment tool and the API route share one implementation. Every
 * validation the route enforced lives here: charge ownership, not-already-paid,
 * ACH enabled on each listing, all charges under one manager, and that
 * manager's Connect account being ready for destination charges.
 */

// Stripe limits a metadata value to 500 chars. Charge ids are joined into the
// `charge_ids` value the webhook reads back, so cap the bulk count to keep the
// CSV safely under that limit and never truncate an id (which would silently
// leave a paid charge unmarked).
export const MAX_BULK_CHARGES = 10;

export function chargeOwnedByUser(charge: HouseholdCharge, userId: string, email: string): boolean {
  const e = email.trim().toLowerCase();
  if (charge.residentUserId && charge.residentUserId === userId) return true;
  return Boolean(e && charge.residentEmail.trim().toLowerCase() === e);
}

export type HouseholdChargeCheckoutFailure = {
  ok: false;
  /** HTTP status the API route responds with. */
  status: number;
  /** Machine-readable code the payments UI branches on (subset of failures). */
  code?: string;
  error: string;
};

export type LoadedHouseholdChargeForCheckout = {
  id: string;
  charge: HouseholdCharge;
  managerUserId: string;
  /**
   * This property's own processing-fee setting, or null to follow the manager's account.
   * Carried out of the per-charge load so the batch can be checked for agreement before one
   * total is billed.
   */
  propertyFeePayer?: "resident" | "manager" | "proplane" | null;
};

/**
 * Resolve + validate the requested charge ids against the authenticated
 * resident's own records: existence, not paid, owned by this user, ACH enabled
 * on the listing, and a single owning manager across the batch. Read-only —
 * also used by the agent tool's preview phase.
 */
export async function loadHouseholdChargesForCheckout(
  db: SupabaseClient,
  input: { userId: string; userEmail: string; chargeIds: string[]; expectedManagerUserId?: string },
): Promise<
  | { ok: true; loaded: LoadedHouseholdChargeForCheckout[]; managerUserId: string }
  | HouseholdChargeCheckoutFailure
> {
  const userEmail = input.userEmail.trim().toLowerCase();
  const uniqueIds = [...new Set(input.chargeIds.map((id) => id.trim()).filter(Boolean))];
  if (uniqueIds.length === 0) {
    return { ok: false, status: 400, error: "chargeId or chargeIds is required." };
  }
  if (uniqueIds.length > MAX_BULK_CHARGES) {
    return { ok: false, status: 400, error: `You can pay at most ${MAX_BULK_CHARGES} charges at once.` };
  }

  const loaded: LoadedHouseholdChargeForCheckout[] = [];
  for (const id of uniqueIds) {
    const { data: row, error: rowErr } = await db
      .from("portal_household_charge_records")
      .select("id, row_data, status, manager_user_id")
      .eq("id", id)
      .maybeSingle();

    if (rowErr) return { ok: false, status: 500, error: rowErr.message };
    if (!row) return { ok: false, status: 404, error: `Charge not found: ${id}` };

    const charge = row.row_data as HouseholdCharge | null;
    if (!charge?.id) return { ok: false, status: 500, error: "Invalid charge record." };
    if (row.status === "paid" || charge.status === "paid") {
      return { ok: false, status: 409, error: "One or more selected charges are already paid." };
    }
    if (!chargeOwnedByUser(charge, input.userId, userEmail)) {
      return { ok: false, status: 403, error: "You do not have access to one of the selected charges." };
    }

    const managerUserId = (row.manager_user_id as string | null)?.trim() || charge.managerUserId?.trim() || "";
    if (!managerUserId) {
      return { ok: false, status: 422, error: "A selected charge is not linked to a property manager yet." };
    }
    if (input.expectedManagerUserId && managerUserId !== input.expectedManagerUserId) {
      return { ok: false, status: 403, error: "You do not have access to one of the selected charges." };
    }

    const listing =
      listingFromPropertyData(
        (
          await db
            .from("manager_property_records")
            .select("property_data")
            .eq("id", charge.propertyId)
            .maybeSingle()
        ).data?.property_data,
      ) ?? (await resolveListingForHouseholdCharge(db, charge, managerUserId));

    if (!axisPaymentsEnabledOnListing(listing)) {
      return {
        ok: false,
        status: 422,
        code: "AXIS_PAYMENTS_DISABLED",
        error: "Bank (ACH) payments are not enabled for all selected properties.",
      };
    }

    loaded.push({ id, charge, managerUserId, propertyFeePayer: listing?.serviceFeePayer ?? null });
  }

  const managerIds = [...new Set(loaded.map((row) => row.managerUserId))];
  if (managerIds.length !== 1) {
    return {
      ok: false,
      status: 422,
      error: "Pay selected charges together only when they belong to the same property manager.",
    };
  }

  return { ok: true, loaded, managerUserId: managerIds[0]! };
}

type CheckoutSharedFields = {
  sessionId: string;
  amountCents: number;
  subtotalCents: number;
  processingFeeCents: number;
  axisFeeCents: number;
  platformFeeCents: number;
  totalCents: number;
  paymentMethod: ResidentAxisPaymentMethod;
  chargeIds: string[];
};

export type HouseholdChargeCheckoutSuccess =
  | ({ ok: true; mode: "embedded"; clientSecret: string } & CheckoutSharedFields)
  | ({ ok: true; mode: "hosted"; url: string } & CheckoutSharedFields);

export type HouseholdChargeCheckoutResult = HouseholdChargeCheckoutSuccess | HouseholdChargeCheckoutFailure;

/**
 * Create a Stripe Checkout session (embedded or hosted) for one or more of the
 * resident's pending household charges. Never throws — Stripe/config failures
 * are returned with the same status/code mapping the API route always sent.
 */
export async function createHouseholdChargeCheckout(
  db: SupabaseClient,
  input: {
    userId: string;
    userEmail: string;
    chargeIds: string[];
    mode: "embedded" | "hosted";
    paymentMethod: ResidentAxisPaymentMethod;
    expectedManagerUserId?: string;
    /** Origin used to build the success/cancel/return URLs. */
    appOrigin: string;
  },
): Promise<HouseholdChargeCheckoutResult> {
  try {
    const resolved = await loadHouseholdChargesForCheckout(db, input);
    if (!resolved.ok) return resolved;
    const { loaded, managerUserId } = resolved;

    const { tier: managerTierRaw, promoCode } = await getManagerPurchaseSku(managerUserId);
    const managerTier = normalizeManagerSkuTier(managerTierRaw) ?? "free";
    const managerSettings = await loadManagerManualPaymentSettings(db, managerUserId);
    const propertyChoices = [...new Set(loaded.map((row) => row.propertyFeePayer ?? "inherit"))];
    if (propertyChoices.length > 1) {
      return {
        ok: false,
        status: 422,
        code: "MIXED_SERVICE_FEE_PAYERS",
        error: "These charges are on properties with different processing-fee settings. Pay them separately.",
      };
    }

    const feePayer = resolveServiceFeePayerFor({
      tier: managerTier,
      adminOverride: managerSettings.adminServiceFeeOverride,
      propertyChoice: loaded[0]?.propertyFeePayer ?? null,
      managerChoice: managerSettings.serviceFeePayer,
      waiverGranted: Boolean(promoCode?.trim()),
    });
    const stripe = getStripe();
    const connect = await resolveAndValidateManagerConnectForPayments(stripe, db, managerUserId);
    if (!connect.ok) {
      return {
        ok: false,
        status: 422,
        code: connect.code === "NO_ACCOUNT" ? "MANAGER_NO_CONNECT_ACCOUNT" : "MANAGER_CONNECT_TRANSFERS_NOT_READY",
        error: connect.error,
      };
    }

    const lineItems = loaded.map(({ charge }) => {
      const amountCents = householdChargeAmountCents(charge);
      if (amountCents < 100 || amountCents > 500_000) {
        throw new Error("Each charge must be between $1.00 and $5,000.00.");
      }
      return {
        amountCents,
        productName: charge.title?.trim() || "Resident payment",
        productDescription: charge.propertyLabel?.trim() || "Axis",
      };
    });

    const amountCents = lineItems.reduce((sum, item) => sum + item.amountCents, 0);
    const residentEmail = loaded[0]!.charge.residentEmail.trim().toLowerCase();
    const chargeIdsCsv = loaded.map((row) => row.id).join(",");

    const metadata: Record<string, string> = {
      purpose: HOUSEHOLD_CHARGE_CHECKOUT_PURPOSE,
      charge_id: loaded[0]!.id,
      charge_ids: chargeIdsCsv,
      property_id: loaded[0]!.charge.propertyId.slice(0, 450),
      resident_email: residentEmail.slice(0, 450),
      manager_user_id: managerUserId,
      bulk: loaded.length > 1 ? "true" : "false",
    };

    const result = await createAxisAchCheckoutSession(stripe, {
      residentEmail,
      lineItems,
      metadata,
      destinationAccountId: connect.accountId,
      mode: input.mode,
      paymentMethod: input.paymentMethod,
      managerTier,
      feePayer,
      returnUrl: `${input.appOrigin}/resident/payments?ach_checkout=return&session_id={CHECKOUT_SESSION_ID}`,
      successUrl: `${input.appOrigin}/resident/payments?ach_checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${input.appOrigin}/resident/payments?ach_checkout=cancel`,
    });

    const shared: CheckoutSharedFields = {
      sessionId: result.sessionId,
      amountCents,
      subtotalCents: result.subtotalCents,
      processingFeeCents: result.processingFeeCents,
      axisFeeCents: result.axisFeeCents,
      platformFeeCents: result.platformFeeCents,
      totalCents: result.totalCents,
      paymentMethod: result.paymentMethod,
      chargeIds: loaded.map((row) => row.id),
    };
    if (result.mode === "embedded") {
      return { ok: true, mode: "embedded", clientSecret: result.clientSecret, ...shared };
    }
    return { ok: true, mode: "hosted", url: result.url, ...shared };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Checkout failed";
    if (stripeNotConfiguredError(message)) {
      return {
        ok: false,
        status: 503,
        code: "STRIPE_NOT_CONFIGURED",
        error: "Stripe is not configured on the server (missing STRIPE_SECRET_KEY).",
      };
    }
    if (isStripeConnectAccountAccessError(message)) {
      return { ok: false, status: 422, code: "MANAGER_CONNECT_STALE", error: managerConnectReconnectMessage() };
    }
    return { ok: false, status: 500, error: message };
  }
}
