import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import type { HouseholdCharge } from "@/lib/household-charges";
import { listingFromPropertyData } from "@/lib/household-charge-payment-eligibility";
import { resolvePropertylessManagerPaymentPolicy } from "@/lib/household-charge-payment-eligibility.server";
import { normalizeManagerSkuTier } from "@/lib/manager-access";
import { getManagerPurchaseSku } from "@/lib/manager-access-server";
import { loadManagerManualPaymentSettings } from "@/lib/manager-manual-payment-settings";
import {
  axisPaymentsEnabledOnListing,
  acceptedPaymentMethodsForListing,
  resolveServiceFeePayerFor,
  residentServiceFeeBreakdown,
  type ResidentAxisPaymentMethod,
  type ServiceFeePayer,
} from "@/lib/payment-policy";
import { getStripe } from "@/lib/stripe";
import {
  listingPaymentWaiverCodeMatchesServer,
  resolveAccountOrListingWaiverGrantedServer,
} from "@/lib/payment-policy.server";
import { loadWorkspacePaymentSettingsForProperty } from "@/lib/workspace-payment-settings.server";
import { createAxisAchCheckoutSession, stripeNotConfiguredError, type AxisAchCheckoutInput } from "@/lib/stripe-axis-ach-checkout";
import {
  isStripeConnectAccountAccessError,
  managerConnectReconnectMessage,
} from "@/lib/stripe-connect";
import { householdChargeAmountCents, HOUSEHOLD_CHARGE_CHECKOUT_PURPOSE } from "@/lib/stripe-household-charge";
import { captureTestWorkspaceEffectForUser } from "@/lib/test-workspaces/effects.server";
import { assertResidentCheckoutAttemptTerms, assertResidentCheckoutSession,
  type ResidentCheckoutAttempt } from "@/lib/resident-checkout-claim.server";

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
  if (charge.residentUserId) return charge.residentUserId === userId;
  return Boolean(e && charge.residentEmail.trim().toLowerCase() === e);
}

/**
 * Resolve who pays the service fee for a batch of already-loaded charges (all
 * on the same manager and, per the caller's own mixed-payer guard, the same
 * property choice) — the exact precedence `createHouseholdChargeCheckout`
 * applies, extracted so autopay's off-session PaymentIntent charges through
 * the SAME resolver rather than re-deriving the fee payer for a Checkout
 * Session it will never create.
 */
export async function resolveHouseholdChargeFeePayer(
  db: SupabaseClient,
  managerUserId: string,
  loaded: Pick<LoadedHouseholdChargeForCheckout, "charge" | "propertyFeePayer" | "propertyFeeWaiverCode">[],
): Promise<{ ok: true; feePayer: ServiceFeePayer; managerTier: string } | HouseholdChargeCheckoutFailure> {
  const { tier: managerTierRaw, promoCode, readFailed } = await getManagerPurchaseSku(managerUserId);
  if (readFailed) return { ok: false, status: 500, error: "Payment plan could not be verified. Try again." };
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

  /* Payment setup is answered per workspace, so a house with no choice of its
     own follows the workspace it belongs to before falling back to the
     account. Every charge here is on one property (the mixed-payer guard
     above), so one lookup answers for the batch. */
  const workspace = await loadWorkspacePaymentSettingsForProperty(db, managerUserId, loaded[0]?.charge.propertyId);

  const feePayer = resolveServiceFeePayerFor({
    tier: managerTier,
    adminOverride: managerSettings.adminServiceFeeOverride,
    propertyChoice: loaded[0]?.propertyFeePayer ?? null,
    workspaceChoice: workspace.serviceFeePayer,
    managerChoice: managerSettings.serviceFeePayer,
    /* The workspace's own code counts alongside the account grant and the
       listing's code: PropLane pays is applied per workspace by a code. */
    waiverGranted:
      resolveAccountOrListingWaiverGrantedServer(promoCode, loaded[0]?.propertyFeeWaiverCode) ||
      listingPaymentWaiverCodeMatchesServer(workspace.serviceFeeWaiverCode),
  });
  return { ok: true, feePayer, managerTier };
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
  propertyFeeWaiverCode?: string | null;
  acceptedPaymentMethods: readonly ResidentAxisPaymentMethod[];
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
    if (!["pending", "failed", "processing"].includes(row.status ?? charge.status)) {
      return { ok: false, status: 409, error: "One or more selected charges are no longer available for payment." };
    }
    if (!chargeOwnedByUser(charge, input.userId, userEmail)) {
      return { ok: false, status: 403, error: "You do not have access to one of the selected charges." };
    }

    const rowManagerUserId = (row.manager_user_id as string | null)?.trim() || "";

    const propertyId = charge.propertyId?.trim() ?? "";
    type PropertyPayeeRow = { property_data?: unknown; manager_user_id?: string | null };
    let propertyRecord: PropertyPayeeRow | null = null;
    if (propertyId) {
      const { data: propertyRow, error: propertyErr } = await db
        .from("manager_property_records")
        .select("property_data, manager_user_id")
        .eq("id", propertyId)
        .maybeSingle();
      if (propertyErr) {
        // A property that cannot be read is not a property without an owner.
        // Refuse rather than fall back to the payee named on the charge row.
        return {
          ok: false,
          status: 503,
          error: "Could not confirm who this payment goes to. Try again in a moment.",
        };
      }
      propertyRecord = (propertyRow as PropertyPayeeRow | null) ?? null;
    }

    // The property owner is the payee. An older charge booked under a
    // co-manager needs books review before a new provider capture; switching
    // its payee here would leave its existing AR/income owner inconsistent.
    const propertyOwnerUserId = String(propertyRecord?.manager_user_id ?? "").trim();
    const managerUserId = propertyOwnerUserId || rowManagerUserId;
    if (propertyId && !propertyOwnerUserId) {
      return { ok: false, status: 422, code: "UNRESOLVED_LISTING",
        error: "This property's payment owner could not be confirmed." };
    }
    if (!managerUserId) {
      return { ok: false, status: 422, error: "A selected charge is not linked to a property manager yet." };
    }
    if (charge.managerUserId?.trim() !== managerUserId || rowManagerUserId !== managerUserId) {
      return { ok: false, status: 409, code: "PAYMENT_SOURCE_REVIEW",
        error: "This charge needs a payment and accounting review before it can be paid online." };
    }
    if (input.expectedManagerUserId && managerUserId !== input.expectedManagerUserId) {
      return { ok: false, status: 403, error: "You do not have access to one of the selected charges." };
    }

    // A charge pinned to a property must use that property's current listing.
    // A missing or malformed row cannot inherit permissive defaults or borrow
    // another same-named listing from the manager's portfolio.
    const listing = propertyId ? listingFromPropertyData(propertyRecord?.property_data) : null;

    if (propertyId && !listing) {
      return {
        ok: false,
        status: 422,
        code: "UNRESOLVED_LISTING",
        error: "This property's payment settings could not be confirmed. Try again after the listing is saved.",
      };
    }

    const propertylessPolicy = propertyId ? null : await resolvePropertylessManagerPaymentPolicy(db, managerUserId);
    if (!propertyId && propertylessPolicy === null) {
      return { ok: false, status: 422, code: "UNRESOLVED_LISTING",
        error: "This charge's payment settings could not be confirmed. Try again after they are saved." };
    }
    if (propertyId ? !axisPaymentsEnabledOnListing(listing) : propertylessPolicy === false) {
      return {
        ok: false,
        status: 422,
        code: "AXIS_PAYMENTS_DISABLED",
        error: "Bank (ACH) payments are not enabled for all selected properties.",
      };
    }

    loaded.push({
      id,
      charge,
      managerUserId,
      propertyFeePayer: listing?.serviceFeePayer ?? null,
      propertyFeeWaiverCode: listing?.serviceFeeWaiverCode ?? null,
      acceptedPaymentMethods: listing ? acceptedPaymentMethodsForListing(listing) : ["ach", "card"],
    });
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
  | ({ ok: true; mode: "hosted"; url: string } & CheckoutSharedFields)
  | ({ ok: true; mode: "manual_ach"; clientSecret: string; paymentIntentId: string;
      bankStatus: "entry" | "verification" | "clearing" | "paid" } & CheckoutSharedFields);

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
    /** Server-owned return path (path + query only). Never accept a full client URL here. */
    returnPath?: string;
  },
): Promise<HouseholdChargeCheckoutResult> {
  try {
    const resolved = await loadHouseholdChargesForCheckout(db, input);
    if (!resolved.ok) return resolved;
    const { loaded, managerUserId } = resolved;
    if (loaded.some(row => !row.acceptedPaymentMethods.includes(input.paymentMethod))) {
      return { ok: false, status: 422, code: "PAYMENT_METHOD_DISABLED",
        error: "A selected charge does not accept this payment method." };
    }
    if (input.paymentMethod === "ach" && input.mode === "hosted") {
      return { ok: false, status: 422, code: "IN_APP_BANK_PAYMENT",
        error: "Open Payments in PropLane to enter and verify a bank account." };
    }
    if ((await captureTestWorkspaceEffectForUser({
      userId: input.userId,
      kind: "payment",
      summary: "Resident payment refused for a test workspace.",
      db,
    })).captured) {
      return { ok: false, status: 403, code: "TEST_WORKSPACE_PROVIDER_DISABLED", error: "Payments are unavailable for test accounts." };
    }

    const feePayerResolved = await resolveHouseholdChargeFeePayer(db, managerUserId, loaded);
    if (!feePayerResolved.ok) return feePayerResolved;
    const { feePayer, managerTier } = feePayerResolved;
    const ordered = [...loaded].sort((a, b) => a.id.localeCompare(b.id));
    const lineItems = ordered.map(({ charge }) => {
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
    const residentEmail = ordered[0]!.charge.residentEmail.trim().toLowerCase();
    if (ordered.some(row => row.charge.residentEmail.trim().toLowerCase() !== residentEmail)) {
      return { ok: false, status: 422, error: "Pay charges for different residents separately." };
    }
    const chargeIds = ordered.map(row => row.id);
    const chargeIdsCsv = chargeIds.join(",");
    const attemptToken = randomUUID();
    const fee = residentServiceFeeBreakdown(amountCents, input.paymentMethod, feePayer);
    if (fee.managerPayoutCents <= 0 || fee.applicationFeeCents >= fee.totalCents) {
      return { ok: false, status: 422, error: "Service fee configuration prevents this charge." };
    }

    const metadata: Record<string, string> = {
      purpose: HOUSEHOLD_CHARGE_CHECKOUT_PURPOSE,
      charge_id: chargeIds[0]!,
      charge_ids: chargeIdsCsv,
      property_id: (ordered[0]!.charge.propertyId ?? "").slice(0, 450),
      resident_email: residentEmail.slice(0, 450),
      manager_user_id: managerUserId,
      bulk: loaded.length > 1 ? "true" : "false",
      source_arbitration_v: "1",
      resident_attempt_token: attemptToken,
      ...(input.paymentMethod === "ach"
        ? { resident_payment_flow: "manual_ach", manual_ach: "1" } : {}),
    };
    const providerParams: AxisAchCheckoutInput = {
      residentEmail,
      lineItems,
      metadata,
      destinationAccountId: null,
      mode: input.mode,
      paymentMethod: input.paymentMethod,
      managerTier,
      feePayer,
      fundingModel: "connect_destination",
      forceExplicitCard: input.paymentMethod === "card",
      fixedFeeBreakdown: fee,
      idempotencyKey: `resident-checkout:${attemptToken}`,
      ...(input.returnPath ? { redirectOnCompletion: "if_required" as const } : {}),
      returnUrl: `${input.appOrigin}${input.returnPath ?? "/resident/payments"}?ach_checkout=return&session_id={CHECKOUT_SESSION_ID}`,
      successUrl: `${input.appOrigin}${input.returnPath ?? "/resident/payments"}?ach_checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${input.appOrigin}${input.returnPath ?? "/resident/payments"}?ach_checkout=cancel`,
    };
    // This RPC locks every selected charge in sorted order and reserves all
    // slots or none before any external create. An existing cart returns its
    // original immutable provider request, even if pricing changed meanwhile.
    const { data: reserved, error: reserveError } = await db.rpc("reserve_resident_checkout_attempt", {
      p_attempt_token: attemptToken,
      p_resident_user_id: input.userId,
      p_resident_email: residentEmail,
      p_manager_user_id: managerUserId,
      p_charge_ids: chargeIds,
      p_charge_cents: lineItems.map(item => item.amountCents),
      p_subtotal_cents: amountCents,
      p_payer_total_cents: fee.totalCents,
      p_recipient_net_cents: fee.managerPayoutCents,
      p_payment_method: input.paymentMethod,
      p_provider_params: providerParams,
    });
    if (reserveError || !reserved) {
      return { ok: false, status: 409, code: "PAYMENT_IN_PROGRESS",
        error: "A payment already owns one of these charges. Check its status before trying again." };
    }
    const attempt = reserved as ResidentCheckoutAttempt;
    const frozenParams = assertResidentCheckoutAttemptTerms(attempt);
    const frozenFee = frozenParams.fixedFeeBreakdown!;
    if (attempt.resident_user_id !== input.userId || attempt.manager_user_id !== managerUserId ||
        attempt.payment_method !== input.paymentMethod ||
        (attempt.status !== "pending" &&
         !(input.paymentMethod === "ach" && attempt.status === "processing"))) {
      return { ok: false, status: 409, code: "PAYMENT_IN_PROGRESS",
        error: "This payment is already processing or needs review." };
    }
    const stripe = getStripe();
    if (input.paymentMethod === "ach") {
      const manualMetadata = {
        ...frozenParams.metadata,
        principal_cents: String(attempt.subtotal_cents),
        subtotal_cents: String(attempt.subtotal_cents),
        total_cents: String(attempt.payer_total_cents),
        processing_fee_cents: String(attempt.payer_total_cents - attempt.subtotal_cents),
        manager_payout_cents: String(attempt.recipient_net_cents),
        payment_method: "ach",
        fee_payer: String(frozenParams.feePayer),
        platform_hold: "1",
        hold_amount_cents: String(attempt.recipient_net_cents),
      };
      const paymentIntent = attempt.stripe_session_id
        ? await stripe.paymentIntents.retrieve(attempt.stripe_session_id)
        : await stripe.paymentIntents.create({
          amount: attempt.payer_total_cents,
          currency: "usd",
          payment_method_types: ["us_bank_account"],
          payment_method_options: { us_bank_account: { verification_method: "microdeposits" } },
          receipt_email: frozenParams.residentEmail,
          metadata: manualMetadata,
        }, { idempotencyKey: frozenParams.idempotencyKey });
      if (paymentIntent.id !== attempt.stripe_session_id && attempt.stripe_session_id) {
        throw new Error("Bank PaymentIntent changed under the stored attempt.");
      }
      if (paymentIntent.amount !== attempt.payer_total_cents || paymentIntent.currency !== "usd" ||
          Object.entries(manualMetadata).some(([key, value]) => paymentIntent.metadata?.[key] !== value) ||
          paymentIntent.transfer_data?.destination || paymentIntent.application_fee_amount ||
          !paymentIntent.client_secret) {
        throw new Error("Bank PaymentIntent does not match its frozen quote.");
      }
      if (!attempt.stripe_session_id) {
        const { data: bound, error: bindError } = await db.rpc("bind_resident_checkout_session", {
          p_attempt_id: attempt.id, p_attempt_token: attempt.attempt_token,
          p_session_id: paymentIntent.id,
        });
        if (bindError || bound !== true) {
          throw new Error("Bank PaymentIntent could not be bound to its attempt.");
        }
      }
      const bankStatus = paymentIntent.status === "requires_action" &&
        paymentIntent.next_action?.type === "verify_with_microdeposits"
        ? "verification" as const
        : paymentIntent.status === "processing" ? "clearing" as const
          : paymentIntent.status === "succeeded" ? "paid" as const : "entry" as const;
      if (paymentIntent.status === "canceled") {
        return { ok: false, status: 409, code: "PAYMENT_NEEDS_REVIEW",
          error: "This bank payment needs review before another attempt can start." };
      }
      return {
        ok: true, mode: "manual_ach", clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id, bankStatus, sessionId: paymentIntent.id,
        amountCents: attempt.subtotal_cents, subtotalCents: attempt.subtotal_cents,
        processingFeeCents: attempt.payer_total_cents - attempt.subtotal_cents,
        axisFeeCents: 0, platformFeeCents: frozenFee.applicationFeeCents,
        totalCents: attempt.payer_total_cents, paymentMethod: "ach",
        chargeIds: attempt.charge_ids,
      };
    }
    let result: { mode: "embedded"; clientSecret: string; sessionId: string } |
      { mode: "hosted"; url: string; sessionId: string };
    if (attempt.stripe_session_id) {
      const session = await stripe.checkout.sessions.retrieve(attempt.stripe_session_id);
      assertResidentCheckoutSession(attempt, session);
      if (session.status === "expired" && session.payment_status !== "paid") {
        await db.rpc("retire_resident_checkout_attempt", {
          p_attempt_id: attempt.id, p_attempt_token: attempt.attempt_token,
          p_session_id: session.id, p_terminal_status: "expired",
        });
      }
      if (session.status !== "open") {
        return { ok: false, status: 409, code: "PAYMENT_IN_PROGRESS",
          error: "This payment is processing or needs review. Check its status before trying again." };
      }
      if (frozenParams.mode === "embedded") {
        if (!session.client_secret) throw new Error("Stored checkout has no client secret.");
        result = { mode: "embedded" as const, clientSecret: session.client_secret,
          sessionId: session.id };
      } else {
        if (!session.url) throw new Error("Stored checkout has no URL.");
        result = { mode: "hosted" as const, url: session.url, sessionId: session.id };
      }
    } else {
      const ageMs = Date.now() - Date.parse(attempt.created_at);
      // created_at is the database clock, ageMs the app clock: a fresh row can read a
      // few hundred ms in the future. Only an absurd future stamp is suspicious.
      if (!Number.isFinite(ageMs) || ageMs < -5 * 60 * 1000 || ageMs >= 23 * 60 * 60 * 1000) {
        return { ok: false, status: 409, code: "PAYMENT_NEEDS_REVIEW",
          error: "This payment attempt needs review before another checkout can start." };
      }
      result = await createAxisAchCheckoutSession(stripe, frozenParams);
      const { data: bound, error: bindError } = await db.rpc("bind_resident_checkout_session", {
        p_attempt_id: attempt.id, p_attempt_token: attempt.attempt_token,
        p_session_id: result.sessionId,
      });
      if (bindError || bound !== true) {
        throw new Error("Checkout session could not be bound to its payment attempt.");
      }
    }

    const shared: CheckoutSharedFields = {
      sessionId: result.sessionId,
      amountCents,
      subtotalCents: attempt.subtotal_cents,
      processingFeeCents: attempt.payer_total_cents - attempt.subtotal_cents,
      axisFeeCents: 0,
      platformFeeCents: frozenFee.applicationFeeCents,
      totalCents: attempt.payer_total_cents,
      paymentMethod: attempt.payment_method,
      chargeIds: attempt.charge_ids,
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
