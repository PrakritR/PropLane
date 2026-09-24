/**
 * Stripe Checkout for the lease signing fee (PLAN-0924-1254).
 * Each signer pays; success is recorded via `recordLeaseSigningFeePaid` on the
 * lease row after session verification — never by trusting the client alone.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";

import { resolveAppOrigin } from "@/lib/app-url";
import { normalizeManagerSkuTier } from "@/lib/manager-access";
import { getManagerPurchaseSku } from "@/lib/manager-access-server";
import { loadManagerManualPaymentSettings } from "@/lib/manager-manual-payment-settings";
import { resolveLeaseSigningFeeCentsForProperty } from "@/lib/lease-signing-fee";
import { resolveServiceFeePayerFor } from "@/lib/payment-policy";
import { createAxisAchCheckoutSession } from "@/lib/stripe-axis-ach-checkout";
import { resolveConnectDestinationIfReady } from "@/lib/stripe-connect";

export const LEASE_SIGNING_FEE_CHECKOUT_PURPOSE = "lease_signing_fee";

export type LeaseSigningFeeCheckoutInput = {
  leaseId: string;
  managerUserId: string;
  propertyId?: string | null;
  residentUserId: string;
  residentEmail: string;
  returnUrl: string;
};

export async function createLeaseSigningFeeCheckout(
  db: SupabaseClient,
  stripe: Stripe,
  input: LeaseSigningFeeCheckoutInput,
): Promise<
  | { ok: true; clientSecret: string; sessionId: string; feeCents: number }
  | { ok: false; status: number; error: string }
> {
  const feeCents = await resolveLeaseSigningFeeCentsForProperty(
    db,
    input.managerUserId,
    input.propertyId,
  );
  if (feeCents <= 0) {
    return { ok: false, status: 422, error: "No lease signing fee is required." };
  }

  const { tier: managerTierRaw, readFailed } = await getManagerPurchaseSku(input.managerUserId);
  if (readFailed) {
    return { ok: false, status: 503, error: "Payment plan could not be verified. Try again." };
  }
  const managerTier = normalizeManagerSkuTier(managerTierRaw) ?? "free";
  const managerSettings = await loadManagerManualPaymentSettings(db, input.managerUserId);
  const feePayer = resolveServiceFeePayerFor({
    tier: managerTier,
    adminOverride: managerSettings.adminServiceFeeOverride,
    propertyChoice: null,
    workspaceChoice: null,
    managerChoice: managerSettings.serviceFeePayer,
    waiverGranted: false,
  });

  const destinationAccountId = await resolveConnectDestinationIfReady(stripe, db, input.managerUserId);

  const result = await createAxisAchCheckoutSession(stripe, {
    residentEmail: input.residentEmail,
    amountCents: feeCents,
    productName: "Lease signing fee",
    productDescription: `Lease ${input.leaseId.slice(0, 120)}`,
    metadata: {
      purpose: LEASE_SIGNING_FEE_CHECKOUT_PURPOSE,
      lease_id: input.leaseId.slice(0, 450),
      resident_user_id: input.residentUserId.slice(0, 450),
      manager_user_id: input.managerUserId.slice(0, 450),
    },
    mode: "embedded",
    destinationAccountId,
    managerTier,
    feePayer,
    paymentMethod: "card",
    returnUrl: input.returnUrl,
  });

  if (result.mode !== "embedded") {
    return { ok: false, status: 500, error: "Expected an embedded checkout session." };
  }
  return {
    ok: true,
    clientSecret: result.clientSecret,
    sessionId: result.sessionId,
    feeCents,
  };
}

export function leaseSigningFeeReturnUrl(req: Request, leaseId: string): string {
  const origin = resolveAppOrigin(req);
  return `${origin}/resident/lease?leaseId=${encodeURIComponent(leaseId)}&signing_fee=return&session_id={CHECKOUT_SESSION_ID}`;
}
