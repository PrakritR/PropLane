import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import { normalizeManagerSkuTier } from "@/lib/manager-access";
import { getManagerPurchaseSku } from "@/lib/manager-access-server";
import {
  effectiveApplicationFeeCents,
  loadManagerApplicationSettings,
} from "@/lib/manager-application-settings";
import { normalizeManagerListingSubmissionV1, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { loadManagerManualPaymentSettings } from "@/lib/manager-manual-payment-settings";
import { parseMoneyAmount } from "@/lib/parse-money";
import {
  residentServiceFeeBreakdown,
  resolveAccountOrListingWaiverGranted,
  resolveServiceFeePayerFor,
  type ServiceFeePayer,
} from "@/lib/payment-policy";
import { listingApplicationFeeChannels } from "@/lib/rental-application/application-fee-channel";
import {
  APPLICATION_FEE_CHECKOUT_PURPOSE,
  createAxisAchCheckoutSession,
} from "@/lib/stripe-axis-ach-checkout";
import { resolveAndValidateManagerConnectForPayments } from "@/lib/stripe-connect";

/**
 * The Stripe Checkout core for the rental application fee, extracted from
 * `/api/stripe/application-fee-checkout` so it is independently testable
 * (mirrors `stripe-household-charge-checkout.server.ts`). Every validation the
 * route enforces lives here: the property is really owned by the manager id
 * the caller supplied, ACH is enabled on the listing, the fee amount comes
 * from the SERVER-stored listing (never the client), and that manager's
 * Connect account is ready for destination charges.
 *
 * Who bears the payment service fee is resolved live from the manager's plan
 * + Pro setting via `resolveServiceFeePayer` — the SAME resolver and settings
 * loader resident charges use (`stripe-household-charge-checkout.server.ts`),
 * so Free/Pro/Business behave identically for an applicant as they do for a
 * resident. This supersedes the earlier "always face value, PropLane
 * absorbs" application-fee carve-out — see `docs/agents/resident-payments.md`.
 */

export type ApplicationFeeCheckoutFailure = {
  ok: false;
  status: number;
  code?: string;
  error: string;
};

function listingFromPropertyData(propertyData: unknown): ManagerListingSubmissionV1 | null {
  if (!propertyData || typeof propertyData !== "object") return null;
  const submission = (propertyData as { listingSubmission?: unknown }).listingSubmission;
  if (!submission || typeof submission !== "object") return null;
  if ((submission as { v?: unknown }).v !== 1) return null;
  return normalizeManagerListingSubmissionV1(submission as ManagerListingSubmissionV1);
}

function clampAmountCents(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const x = Math.round(n);
  if (x < 100 || x > 100_000) return 0;
  return x;
}

/** Raw per-listing application fee label before manager-default fallback. */
export function listingApplicationFeeRaw(
  listing: ManagerListingSubmissionV1 | null | undefined,
  rentalType?: "standard" | "short_term",
): string {
  if (!listing) return "";
  if (rentalType === "short_term") {
    const st = String(listing.shortTermApplicationFee ?? "").trim();
    if (st !== "") return st;
    return String(listing.applicationFee ?? "").trim();
  }
  return String(listing.applicationFee ?? "").trim();
}

export type ResolvedApplicationFeeProperty = {
  managerUserId: string;
  listing: ManagerListingSubmissionV1 | null;
  applicationFeeCents: number;
};

/**
 * Verifies the client-supplied `managerUserId` really owns `propertyId`
 * (never trust it blindly — otherwise a fee could be routed to an arbitrary
 * manager's Connect account) and resolves the server-stored fee amount.
 *
 * Deliberately does NOT require any particular payment channel — a manager
 * whose listing only offers Zelle/Venmo still has an application fee (and can
 * still issue waiver codes for it), so this is shared by the fee preview, the
 * waiver redeem route, AND the Stripe checkout below, which layers its own
 * ACH-enabled check on top since only IT actually needs Stripe.
 */
export async function resolveApplicationFeeProperty(
  db: SupabaseClient,
  input: { propertyId: string; managerUserId: string; rentalType?: "standard" | "short_term" },
  opts?: {
    /**
     * A 0 effective fee ("applications are free") is a NORMAL answer for the
     * read-only preview — the applicant simply passes through with no payment
     * step. Only the checkout/waiver paths, which exist purely to collect or
     * waive a real fee, treat 0 as a 422.
     */
    allowZeroFee?: boolean;
  },
): Promise<{ ok: true; value: ResolvedApplicationFeeProperty } | ApplicationFeeCheckoutFailure> {
  const { data: propertyRow } = await db
    .from("manager_property_records")
    .select("property_data, manager_user_id")
    .eq("id", input.propertyId)
    .maybeSingle();

  if (!propertyRow) {
    return {
      ok: false,
      status: 404,
      code: "PROPERTY_NOT_FOUND",
      error: "This listing is no longer available.",
    };
  }

  const ownerUserId = String(propertyRow.manager_user_id ?? "").trim();
  if (!ownerUserId) {
    return {
      ok: false,
      status: 404,
      code: "PROPERTY_NOT_FOUND",
      error: "This listing is no longer available.",
    };
  }

  const claimedManager = input.managerUserId.trim();
  if (claimedManager && claimedManager !== ownerUserId) {
    return { ok: false, status: 403, error: "This property is not owned by the specified manager." };
  }

  const listing = listingFromPropertyData(propertyRow?.property_data);
  // The listing's OWN application fee is authoritative ([app-fee-authority] option B); the
  // account-wide setting is only a default for listings that set nothing. An empty string is
  // "unset" → fall back to the account-wide default; any set value (INCLUDING "0" = free) is
  // charged as-is and must never fall through. See `src/lib/manager-application-settings.ts`.
  const managerSettings = await loadManagerApplicationSettings(db, ownerUserId);
  const rawListingFee = listingApplicationFeeRaw(listing, input.rentalType);
  const listingFeeCents =
    rawListingFee === "" ? null : clampAmountCents(parseMoneyAmount(rawListingFee) * 100);
  const applicationFeeCents = clampAmountCents(
    effectiveApplicationFeeCents({
      managerFeeCents: managerSettings.applicationFeeCents,
      listingFeeCents,
    }),
  );
  if (applicationFeeCents <= 0 && !opts?.allowZeroFee) {
    return { ok: false, status: 422, code: "NO_APPLICATION_FEE", error: "This listing has no application fee configured." };
  }

  return { ok: true, value: { managerUserId: ownerUserId, listing, applicationFeeCents } };
}

export type ApplicationFeeItemization = {
  applicationFeeCents: number;
  /** Added on top when the applicant bears it (Free tier, or Pro w/ resident choice); 0 otherwise. */
  serviceFeeCents: number;
  totalCents: number;
  feePayer: ServiceFeePayer;
  managerTier: "free" | "pro" | "business";
};

/**
 * Who bears the service fee + the itemized breakdown, WITHOUT creating any
 * Stripe object — used both to preview the charge before the applicant pays
 * and inside `createApplicationFeeCheckout` so the two can never drift.
 *
 * `channel` matters: a Zelle/Venmo/other application fee is a manual bank
 * transfer that never touches Stripe, so it never incurs Stripe's processing
 * cost — the service fee line is always $0 on that channel, regardless of
 * plan or manager setting. Only the "card" (Stripe Checkout) channel can ever
 * carry a non-zero service fee.
 */
export async function resolveApplicationFeeItemization(
  db: SupabaseClient,
  managerUserId: string,
  applicationFeeCents: number,
  channel: "card" | "manual" = "card",
  listing?: ManagerListingSubmissionV1 | null,
): Promise<ApplicationFeeItemization> {
  const { tier: managerTierRaw, promoCode } = await getManagerPurchaseSku(managerUserId);
  const managerTier = normalizeManagerSkuTier(managerTierRaw) ?? "free";
  const managerSettings = await loadManagerManualPaymentSettings(db, managerUserId);
  const feePayer = resolveServiceFeePayerFor({
    tier: managerTier,
    adminOverride: managerSettings.adminServiceFeeOverride,
    propertyChoice: listing?.serviceFeePayer ?? null,
    managerChoice: managerSettings.serviceFeePayer,
    waiverGranted: resolveAccountOrListingWaiverGranted(promoCode, listing?.serviceFeeWaiverCode),
  });
  const fee =
    channel === "manual" || applicationFeeCents <= 0
      ? { residentAddedFeeCents: 0, totalCents: Math.max(0, applicationFeeCents) }
      : residentServiceFeeBreakdown(applicationFeeCents, "card", feePayer);
  return {
    applicationFeeCents,
    serviceFeeCents: fee.residentAddedFeeCents,
    totalCents: fee.totalCents,
    feePayer,
    managerTier,
  };
}

export type ApplicationFeeCheckoutInput = {
  propertyId: string;
  residentEmail: string;
  residentName?: string;
  managerUserId: string;
  rentalType?: "standard" | "short_term";
  /**
   * `embedded` renders the payment form INLINE in the application (the default
   * — the applicant never leaves the wizard); `hosted` redirects to Stripe's
   * page. Embedded needs `returnUrl`; hosted needs `successUrl` + `cancelUrl`.
   */
  mode?: "embedded" | "hosted";
  returnUrl?: string;
  successUrl?: string;
  cancelUrl?: string;
};

export type ApplicationFeeCheckoutSuccess =
  | { ok: true; mode: "embedded"; clientSecret: string; sessionId: string; itemization: ApplicationFeeItemization }
  | { ok: true; mode: "hosted"; url: string; sessionId: string; itemization: ApplicationFeeItemization };

export async function createApplicationFeeCheckout(
  db: SupabaseClient,
  stripe: Stripe,
  input: ApplicationFeeCheckoutInput,
): Promise<ApplicationFeeCheckoutSuccess | ApplicationFeeCheckoutFailure> {
  const resolved = await resolveApplicationFeeProperty(db, input);
  if (!resolved.ok) return resolved;
  const { managerUserId, applicationFeeCents, listing } = resolved.value;

  if (!listingApplicationFeeChannels(listing ?? undefined).ach) {
    return {
      ok: false,
      status: 422,
      code: "AXIS_PAYMENTS_DISABLED",
      error: "Online card payments are not enabled for this property. Use Zelle or Venmo if available.",
    };
  }

  const connect = await resolveAndValidateManagerConnectForPayments(stripe, db, managerUserId);
  if (!connect.ok) {
    return {
      ok: false,
      status: 422,
      code: connect.code === "NO_ACCOUNT" ? "MANAGER_NO_CONNECT_ACCOUNT" : "MANAGER_CONNECT_TRANSFERS_NOT_READY",
      error: connect.error,
    };
  }

  const itemization = await resolveApplicationFeeItemization(db, managerUserId, applicationFeeCents, "card", listing);

  const metadata: Record<string, string> = {
    purpose: APPLICATION_FEE_CHECKOUT_PURPOSE,
    property_id: input.propertyId.slice(0, 450),
    resident_email: input.residentEmail.toLowerCase().slice(0, 450),
    manager_user_id: managerUserId,
  };
  if (input.residentName) metadata.resident_name = input.residentName.slice(0, 450);

  const mode = input.mode ?? "embedded";
  const result = await createAxisAchCheckoutSession(stripe, {
    residentEmail: input.residentEmail,
    amountCents: applicationFeeCents,
    productName: "Rental application fee",
    productDescription: `Listing ${input.propertyId.slice(0, 120)}`,
    metadata,
    mode,
    destinationAccountId: connect.accountId,
    managerTier: itemization.managerTier,
    feePayer: itemization.feePayer,
    // Card method-class → Stripe Checkout surfaces Apple Pay / Google Pay on
    // eligible devices with a card-entry fallback. A one-time application fee
    // is a far cleaner mobile pay than an ACH bank-login handshake.
    paymentMethod: "card",
    returnUrl: input.returnUrl,
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
  });

  if (result.mode === "embedded") {
    return { ok: true, mode: "embedded", clientSecret: result.clientSecret, sessionId: result.sessionId, itemization };
  }
  return { ok: true, mode: "hosted", url: result.url, sessionId: result.sessionId, itemization };
}
