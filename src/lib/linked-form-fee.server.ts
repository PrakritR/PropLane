import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import type { DemoApplicantRow } from "@/data/demo-portal";
import {
  resolveApplicationFeeItemization,
  resolveApplicationFeeProperty,
} from "@/lib/application-fee-checkout.server";
import {
  loadApplicationAccessRow,
  type LinkedFormRequestRow,
} from "@/lib/application-linked-form-requests.server";
import { listingApplicationFeeChannels } from "@/lib/rental-application/application-fee-channel";
import { openApplicantRow } from "@/lib/security/applicant-identity";
import {
  axisAchCheckoutPaid,
  createAxisAchCheckoutSession,
} from "@/lib/stripe-axis-ach-checkout";
import { resolveConnectDestinationIfReady } from "@/lib/stripe-connect";

/**
 * A linked form's own fee, charged to whoever submits it.
 *
 * The amount is NEVER read from a request body: it is re-resolved here from the stored listing (the template's
 * own `feeCentsOverride`, else the listing's application fee for the application's lease term), exactly the
 * chain the applicant fee uses. The checkout carries its own purpose so the application-fee webhook and
 * verify paths (which would mark the APPLICANT's fee paid) never see it.
 */
export const LINKED_FORM_FEE_PURPOSE = "linked_form_fee";

export type LinkedFormFeeFailure = { ok: false; status: number; error: string; code?: string };

async function resolveFee(db: SupabaseClient, request: LinkedFormRequestRow) {
  const app = await loadApplicationAccessRow(db, request.application_id);
  if (!app) return null;
  const row = openApplicantRow(app.row_data, app.id, true, { soft: true }) as DemoApplicantRow;
  const propertyId =
    row.assignedPropertyId?.trim() ||
    row.propertyId?.trim() ||
    (row.application as { propertyId?: string } | undefined)?.propertyId?.trim() ||
    String(app.assigned_property_id ?? app.property_id ?? "").trim();
  if (!propertyId) return null;
  const leaseTerm = String((row.application as { leaseTerm?: string } | undefined)?.leaseTerm ?? "").trim() || undefined;
  const fee = await resolveApplicationFeeProperty(
    db,
    { propertyId, managerUserId: request.manager_user_id, leaseTerm, applicationTemplateId: request.form_id },
    { allowZeroFee: true },
  );
  if (!fee.ok) return null;
  return { propertyId, ...fee.value };
}

/** True when this request still needs a payment before it can be submitted. */
export function linkedFormFeeOwed(request: Pick<LinkedFormRequestRow, "fee_cents" | "fee_paid_at">): boolean {
  return (request.fee_cents ?? 0) > 0 && !request.fee_paid_at;
}

/** Starts a hosted Checkout for this request's fee, billed to the signed-in person who will submit it. */
export async function createLinkedFormFeeCheckout(
  db: SupabaseClient,
  stripe: Stripe,
  input: { request: LinkedFormRequestRow; payer: { id: string; email: string }; origin: string },
): Promise<{ ok: true; url: string; sessionId: string } | LinkedFormFeeFailure> {
  const { request, payer } = input;
  if (request.form_kind !== "application") return { ok: false, status: 400, error: "This form has no fee." };
  if (request.status !== "owed" && request.status !== "shared") {
    return { ok: false, status: 409, error: "This form is already finished." };
  }
  if (request.fee_paid_at) return { ok: false, status: 409, error: "This fee is already paid." };
  const resolved = await resolveFee(db, request);
  if (!resolved) return { ok: false, status: 404, error: "This form is unavailable." };
  const feeCents = resolved.applicationFeeCents;
  if (feeCents <= 0) return { ok: false, status: 409, error: "This form has no fee." };
  if (!listingApplicationFeeChannels(resolved.listing ?? undefined).ach) {
    return { ok: false, status: 422, error: "Online payments are not enabled for this property.", code: "AXIS_PAYMENTS_DISABLED" };
  }
  const itemization = await resolveApplicationFeeItemization(
    db,
    resolved.managerUserId,
    feeCents,
    resolved.listing,
    resolved.propertyId,
  );
  const destinationAccountId = await resolveConnectDestinationIfReady(stripe, db, resolved.managerUserId);
  const path = `/f/open/${encodeURIComponent(request.id)}`;
  const session = await createAxisAchCheckoutSession(stripe, {
    residentEmail: payer.email,
    amountCents: feeCents,
    productName: "Form fee",
    productDescription: `Application ${request.application_id.slice(0, 80)}`,
    metadata: {
      purpose: LINKED_FORM_FEE_PURPOSE,
      linked_form_request_id: request.id,
      payer_user_id: payer.id,
      manager_user_id: resolved.managerUserId,
      property_id: resolved.propertyId.slice(0, 450),
      resident_email: payer.email.toLowerCase().slice(0, 450),
      fee_cents: String(feeCents),
    },
    mode: "hosted",
    destinationAccountId,
    managerTier: itemization.managerTier,
    feePayer: itemization.feePayer,
    paymentMethod: "card",
    successUrl: `${input.origin}${path}?fee_session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${input.origin}${path}?fee=cancel`,
  });
  if (session.mode !== "hosted") return { ok: false, status: 500, error: "Checkout could not be started." };
  // Remember the amount this checkout charged so a later fee change cannot unpay it.
  await db.from("application_form_requests").update({ fee_cents: feeCents, updated_at: new Date().toISOString() }).eq("id", request.id);
  return { ok: true, url: session.url, sessionId: session.sessionId };
}

/**
 * Confirms a paid Checkout session belongs to THIS request and THIS payer, then records it. Idempotent: a
 * second call with the same session changes nothing.
 */
export async function verifyLinkedFormFeePayment(
  db: SupabaseClient,
  stripe: Stripe,
  input: { request: LinkedFormRequestRow; payerUserId: string; sessionId: string },
): Promise<{ ok: true; paid: boolean } | LinkedFormFeeFailure> {
  const sessionId = input.sessionId.trim();
  if (!/^cs_[A-Za-z0-9_]{8,200}$/.test(sessionId)) return { ok: false, status: 400, error: "Missing payment session." };
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  const meta = session.metadata ?? {};
  if (
    meta.purpose !== LINKED_FORM_FEE_PURPOSE ||
    meta.linked_form_request_id !== input.request.id ||
    meta.payer_user_id !== input.payerUserId
  ) {
    return { ok: false, status: 400, error: "That payment is not for this form." };
  }
  if (!axisAchCheckoutPaid(session)) return { ok: true, paid: false };
  const paidCents = Number(meta.fee_cents);
  if (!Number.isFinite(paidCents) || paidCents < (input.request.fee_cents ?? 0)) {
    return { ok: false, status: 409, error: "That payment does not cover this form's fee." };
  }
  const now = new Date().toISOString();
  await db
    .from("application_form_requests")
    .update({ fee_session_id: session.id, fee_paid_at: now, fee_paid_by_user_id: input.payerUserId, updated_at: now })
    .eq("id", input.request.id)
    .is("fee_paid_at", null);
  return { ok: true, paid: true };
}
