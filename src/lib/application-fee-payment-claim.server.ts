import "server-only";

import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { applicationFeeChargeIdForApplication } from "@/lib/household-charges";
import { residentServiceFeeBreakdown, type ResidentServiceFeeBreakdown, type ServiceFeePayer } from "@/lib/payment-policy";
import { resolveConnectDestinationIfReady } from "@/lib/stripe-connect";
import { listingApplicationFeeChannels } from "@/lib/rental-application/application-fee-channel";
import { loadManagerApplicationSettings } from "@/lib/manager-application-settings";
import { resolveApplicationFeeChargePolicy } from "@/lib/rental-application/listing-application-fee-policy";
import { shouldWaiveApplicationFeeForResidentServer } from "@/lib/rental-application/application-policy.server";
import {
  APPLICATION_FEE_BASIS_VERSION,
  resolveApplicationFeeItemization,
  resolveApplicationFeeProperty,
  type ApplicationFeeCheckoutFailure,
  type ApplicationFeeCheckoutInput,
} from "@/lib/application-fee-checkout.server";
import {
  APPLICATION_FEE_CHECKOUT_PURPOSE,
  createAxisAchCheckoutSession,
  type AxisAchCheckoutInput,
} from "@/lib/stripe-axis-ach-checkout";

type PersistedParams = Pick<AxisAchCheckoutInput,
  "residentEmail" | "amountCents" | "productName" | "productDescription" | "metadata" |
  "destinationAccountId" | "managerTier" | "feePayer" | "paymentMethod" | "returnUrl" |
  "forceExplicitCard" | "fixedFeeBreakdown"> & { mode: "embedded"; draftSelectors: string };

export type ApplicationFeeClaim = {
  application_id: string;
  manager_user_id: string;
  property_id: string;
  resident_email: string;
  charge_id: string;
  attempt_token: string;
  stripe_session_id: string | null;
  stripe_charge_id: string | null;
  principal_cents: number;
  processing_fee_cents: number;
  payer_total_cents: number;
  recipient_net_cents: number;
  provider_params: PersistedParams;
  draft_updated_at: string;
  charge_policy: "first_only" | "every_time";
  status: "pending" | "settled" | "expired";
  created_at: string;
  updated_at: string;
};

function validClaim(row: ApplicationFeeClaim, input: { applicationId: string; propertyId: string; residentEmail: string; managerUserId: string }): void {
  if (row.application_id !== input.applicationId || row.property_id !== input.propertyId ||
      row.resident_email !== input.residentEmail.trim().toLowerCase() ||
      row.manager_user_id !== input.managerUserId || row.status !== "pending") {
    throw new Error("Application payment claim does not match this draft.");
  }
}

function validStoredParams(claim: ApplicationFeeClaim): PersistedParams {
  const params = claim.provider_params;
  if (!params || params.mode !== "embedded" || params.paymentMethod !== "card" ||
      params.forceExplicitCard !== true ||
      params.amountCents !== claim.principal_cents ||
      params.residentEmail?.trim().toLowerCase() !== claim.resident_email ||
      params.metadata?.purpose !== APPLICATION_FEE_CHECKOUT_PURPOSE ||
      params.metadata?.application_id !== claim.application_id ||
      params.metadata?.manager_user_id !== claim.manager_user_id ||
      params.metadata?.fee_cents !== String(claim.principal_cents) ||
      !["resident", "manager", "proplane"].includes(String(params.feePayer)) ||
      !["free", "pro", "business"].includes(String(params.managerTier)) ||
      !params.returnUrl?.trim() || !params.draftSelectors) {
    throw new Error("Stored application payment terms are incomplete.");
  }
  const fee = params.fixedFeeBreakdown as ResidentServiceFeeBreakdown | undefined;
  if (!fee || !Object.values(fee).every((value) => Number.isSafeInteger(value) && value >= 0) ||
      fee.totalCents !== claim.principal_cents + fee.residentAddedFeeCents ||
      fee.totalCents - fee.applicationFeeCents !== fee.managerPayoutCents) {
    throw new Error("Stored application payment quote is invalid.");
  }
  if (fee.residentAddedFeeCents !== claim.processing_fee_cents ||
      fee.totalCents !== claim.payer_total_cents || fee.managerPayoutCents !== claim.recipient_net_cents) {
    throw new Error("Stored application payment quote no longer reconciles.");
  }
  return params;
}

function draftSelectors(input: ApplicationFeeCheckoutInput): string {
  return JSON.stringify({
    rentalType: input.rentalType === "short_term" ? "short_term" : "standard",
    leaseTerm: input.leaseTerm?.trim() || "",
    roomChoice1: input.roomChoice1?.trim() || "",
    bundleId: input.bundleId?.trim() || "",
    applicationTemplateId: input.applicationTemplateId?.trim() || "",
  });
}

function validExistingSession(session: Stripe.Checkout.Session, claim: ApplicationFeeClaim): void {
  if (session.mode !== "payment" || session.metadata?.purpose !== APPLICATION_FEE_CHECKOUT_PURPOSE ||
      session.metadata?.application_id !== claim.application_id ||
      session.metadata?.attempt_token !== claim.attempt_token ||
      session.metadata?.manager_user_id !== claim.manager_user_id ||
      session.metadata?.property_id !== claim.property_id ||
      session.metadata?.resident_email?.toLowerCase() !== claim.resident_email ||
      session.metadata?.fee_cents !== String(claim.principal_cents) ||
      session.amount_total !== claim.payer_total_cents || session.currency?.toLowerCase() !== "usd") {
    throw new Error("Existing application Checkout does not match its claim.");
  }
}

function resultFromClaim(claim: ApplicationFeeClaim, clientSecret: string) {
  return {
    ok: true as const, mode: "embedded" as const,
    clientSecret, sessionId: claim.stripe_session_id!,
    itemization: {
      applicationFeeCents: claim.principal_cents,
      serviceFeeCents: claim.processing_fee_cents,
      totalCents: claim.payer_total_cents,
      feePayer: claim.provider_params.feePayer as ServiceFeePayer,
      managerTier: claim.provider_params.managerTier as "free" | "pro" | "business",
    },
  };
}

/** Every public fee Checkout must pass through the exact persisted draft and
 * this immutable attempt before its Stripe secret is exposed. An ambiguous
 * Stripe create is retried with the SAME parameters/key, never released. */
export async function createClaimedApplicationFeeCheckout(
  db: SupabaseClient,
  stripe: Stripe,
  input: ApplicationFeeCheckoutInput & { applicationId: string; mode: "embedded"; draftUpdatedAt: string },
): Promise<ReturnType<typeof resultFromClaim> | ApplicationFeeCheckoutFailure> {
  const email = input.residentEmail.trim().toLowerCase();
  const { data: existing, error: existingError } = await db.from("application_fee_payment_claims")
    .select("*").eq("application_id", input.applicationId).maybeSingle();
  if (existingError) throw new Error(existingError.message);

  const buildNewTerms = async (): Promise<{
    params: PersistedParams; principalCents: number; processingFeeCents: number; recipientNetCents: number;
    chargePolicy: "first_only" | "every_time";
  } | ApplicationFeeCheckoutFailure> => {
    const resolved = await resolveApplicationFeeProperty(db, input);
    if (!resolved.ok) return resolved;
    const { managerUserId, applicationFeeCents, listing } = resolved.value;
    if (!listing || !listingApplicationFeeChannels(listing).ach) return {
      ok: false, status: 422, code: "AXIS_PAYMENTS_DISABLED",
      error: "Online payments are not enabled for this property. Contact the manager before applying.",
    };
    const managerSettings = await loadManagerApplicationSettings(db, managerUserId);
    const chargePolicy = resolveApplicationFeeChargePolicy(listing, managerSettings.applicationFeeChargePolicy);
    if (await shouldWaiveApplicationFeeForResidentServer(db, {
      managerUserId, residentEmail: email, chargePolicy,
    })) return {
      ok: false, status: 409, code: "APPLICATION_FEE_WAIVED",
      error: "This application fee is already waived for you. Continue your application without another payment.",
    };
    const itemization = await resolveApplicationFeeItemization(db, managerUserId, applicationFeeCents, listing, input.propertyId);
    const fee = residentServiceFeeBreakdown(applicationFeeCents, "card", itemization.feePayer);
    if (fee.managerPayoutCents <= 0) throw new Error("Application fee quote cannot pay the manager.");
    const metadata: Record<string, string> = {
      purpose: APPLICATION_FEE_CHECKOUT_PURPOSE,
      application_id: input.applicationId,
      property_id: input.propertyId.slice(0, 450), resident_email: email.slice(0, 450),
      manager_user_id: managerUserId,
      application_template_id: (resolved.value.resolvedApplicationTemplateId ?? "").slice(0, 120),
      fee_cents: String(applicationFeeCents),
      fee_room_id: (resolved.value.feeRoomId ?? "").slice(0, 120),
      fee_lease_term: resolved.value.feeLeaseTerm.slice(0, 40),
      fee_source: resolved.value.feeSource,
      fee_bundle_id: (input.bundleId ?? "").trim().slice(0, 120),
      fee_rental_type: input.rentalType === "short_term" ? "short_term" : "standard",
      fee_basis_v: APPLICATION_FEE_BASIS_VERSION,
    };
    if (input.residentName) metadata.resident_name = input.residentName.slice(0, 450);
    const params: PersistedParams = {
      mode: "embedded", residentEmail: email, amountCents: applicationFeeCents,
      productName: "Rental application fee", productDescription: `Listing ${input.propertyId.slice(0, 120)}`,
      metadata, destinationAccountId: await resolveConnectDestinationIfReady(stripe, db, managerUserId),
      managerTier: itemization.managerTier, feePayer: itemization.feePayer,
      paymentMethod: "card", forceExplicitCard: true, fixedFeeBreakdown: fee,
      draftSelectors: draftSelectors(input),
      returnUrl: input.returnUrl,
    };
    return { params, chargePolicy, principalCents: applicationFeeCents,
      processingFeeCents: fee.residentAddedFeeCents, recipientNetCents: fee.managerPayoutCents };
  };

  let freshTerms: Awaited<ReturnType<typeof buildNewTerms>> | null = null;
  if (!existing || (existing as ApplicationFeeClaim).status === "expired") freshTerms = await buildNewTerms();
  if (freshTerms && "ok" in freshTerms && freshTerms.ok === false) return freshTerms;
  const terms = freshTerms && "params" in freshTerms ? freshTerms : null;
  if (terms?.chargePolicy === "first_only") {
    const { data: other, error: otherError } = await db.from("application_fee_payment_claims")
      .select("application_id,attempt_token,stripe_session_id")
      .eq("manager_user_id", input.managerUserId).eq("resident_email", email)
      .eq("charge_policy", "first_only").eq("status", "pending")
      .neq("application_id", input.applicationId).maybeSingle();
    if (otherError) throw new Error(otherError.message);
    if (other?.stripe_session_id) {
      const prior = await stripe.checkout.sessions.retrieve(other.stripe_session_id);
      if (prior.status === "expired") {
        const retired = await db.rpc("retire_expired_application_fee_checkout", {
          p_application_id: other.application_id, p_attempt_token: other.attempt_token,
          p_session_id: other.stripe_session_id,
        });
        if (retired.error || retired.data !== true) throw new Error("Prior application payment needs reconciliation.");
      } else return {
        ok: false, status: 409, code: "APPLICATION_FEE_IN_PROGRESS",
        error: "An application fee payment is already in progress for this manager. Finish or verify that payment first.",
      };
    } else if (other) return {
      ok: false, status: 409, code: "APPLICATION_FEE_IN_PROGRESS",
      error: "An application fee payment is already starting. Verify its status before retrying.",
    };
  }
  const { data, error } = await db.rpc("reserve_application_fee_checkout", {
    p_application_id: input.applicationId, p_manager_user_id: input.managerUserId,
    p_property_id: input.propertyId, p_resident_email: email,
    p_charge_id: applicationFeeChargeIdForApplication(input.applicationId),
    p_principal_cents: terms?.principalCents ?? (existing as ApplicationFeeClaim).principal_cents,
    p_processing_fee_cents: terms?.processingFeeCents ?? (existing as ApplicationFeeClaim).processing_fee_cents,
    p_recipient_net_cents: terms?.recipientNetCents ?? (existing as ApplicationFeeClaim).recipient_net_cents,
    p_provider_params: terms?.params ?? (existing as ApplicationFeeClaim).provider_params,
    p_draft_updated_at: input.draftUpdatedAt,
    p_charge_policy: terms?.chargePolicy ?? (existing as ApplicationFeeClaim).charge_policy,
  });
  if (error?.code === "23505") return {
    ok: false, status: 409, code: "APPLICATION_FEE_IN_PROGRESS",
    error: "An application fee payment is already in progress. Verify the first payment before retrying.",
  };
  if (error || !data) throw new Error(error?.message ?? "Could not reserve application payment.");
  let claim = data as ApplicationFeeClaim;
  validClaim(claim, { applicationId: input.applicationId, propertyId: input.propertyId, residentEmail: email, managerUserId: input.managerUserId });
  let params = validStoredParams(claim);
  const draftChanged = params.draftSelectors !== draftSelectors(input);

  if (claim.stripe_session_id) {
    let prior = await stripe.checkout.sessions.retrieve(claim.stripe_session_id);
    validExistingSession(prior, claim);
    if (prior.status === "open" && !draftChanged && prior.client_secret) return resultFromClaim(claim, prior.client_secret);
    if (prior.status === "open" && draftChanged) {
      prior = await stripe.checkout.sessions.expire(prior.id);
    }
    if (prior.status !== "expired") {
      throw new Error("Your application payment is processing. Verify its status before retrying.");
    }
    freshTerms = await buildNewTerms();
    if ("ok" in freshTerms && freshTerms.ok === false) return freshTerms;
    const next = freshTerms as Exclude<typeof freshTerms, ApplicationFeeCheckoutFailure>;
    const rotated = await db.rpc("rotate_expired_application_fee_checkout", {
      p_application_id: claim.application_id, p_attempt_token: claim.attempt_token,
      p_session_id: prior.id, p_principal_cents: next.principalCents,
      p_processing_fee_cents: next.processingFeeCents, p_recipient_net_cents: next.recipientNetCents,
      p_provider_params: next.params,
      p_draft_updated_at: input.draftUpdatedAt,
      p_charge_policy: next.chargePolicy,
    });
    if (rotated.error || !rotated.data) throw new Error("Could not retry the expired application payment.");
    claim = rotated.data as ApplicationFeeClaim;
    params = validStoredParams(claim);
  } else if (draftChanged) {
    // A provider create may have succeeded even when its response or DB stamp
    // was lost. Never change the idempotency parameters of that attempt.
    throw new Error("The application changed while payment was starting. Reconcile the pending attempt before retrying.");
  }
  if (Date.now() - new Date(claim.updated_at).getTime() > 23 * 60 * 60 * 1000 && !claim.stripe_session_id) {
    throw new Error("This payment attempt needs reconciliation before it can be retried.");
  }
  const result = await createAxisAchCheckoutSession(stripe, {
    ...params, metadata: { ...params.metadata, attempt_token: claim.attempt_token },
    idempotencyKey: `application-fee:${claim.application_id}:${claim.attempt_token}`,
  });
  if (result.mode !== "embedded" || result.subtotalCents !== claim.principal_cents ||
      result.processingFeeCents !== claim.processing_fee_cents ||
      result.totalCents !== claim.payer_total_cents) {
    throw new Error("Application Checkout returned terms that differ from its claim.");
  }
  const createdSession = await stripe.checkout.sessions.retrieve(result.sessionId);
  validExistingSession(createdSession, claim);
  const bound = await db.rpc("bind_application_fee_checkout_session", {
    p_application_id: claim.application_id, p_attempt_token: claim.attempt_token,
    p_session_id: result.sessionId,
  });
  if (bound.error || bound.data !== true) throw new Error("Application Checkout needs reconciliation before it can be shown.");
  if (createdSession.status !== "open" || !createdSession.client_secret ||
      createdSession.client_secret !== result.clientSecret) {
    throw new Error("Application Checkout is no longer open. Verify or retry this payment before continuing.");
  }
  return resultFromClaim({ ...claim, stripe_session_id: result.sessionId }, result.clientSecret);
}
