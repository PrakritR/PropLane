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
  loadLinkedFormRequest,
  type LinkedFormRequestRow,
} from "@/lib/application-linked-form-requests.server";
import type { HouseholdCharge } from "@/lib/household-charges";
import { syncLedgerPaymentEntry } from "@/lib/reports/ledger-sync";
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

/**
 * An application form's `fee_cents` is never null once resolved: a form with no fee stores 0 (the resolver is
 * called with `allowZeroFee`). Null on an application form therefore means "the lookup failed when the request
 * was written", which must never read as "no fee". A move-in form has no fee, so null is correct there.
 */
export function linkedFormFeeUnresolved(request: Pick<LinkedFormRequestRow, "form_kind" | "fee_cents">): boolean {
  return request.form_kind === "application" && request.fee_cents === null;
}

/**
 * Resolves an unresolved fee from the stored listing (the same server resolver the checkout uses) and stores it.
 * Fails closed: when the fee still cannot be read the caller must refuse the submit rather than treat it as free.
 */
export async function resolveUnresolvedLinkedFormFee(
  db: SupabaseClient,
  request: LinkedFormRequestRow,
): Promise<{ ok: true; request: LinkedFormRequestRow } | { ok: false }> {
  if (!linkedFormFeeUnresolved(request)) return { ok: true, request };
  try {
    const resolved = await resolveFee(db, request);
    if (!resolved) return { ok: false };
    const feeCents = Math.max(0, Math.round(resolved.applicationFeeCents));
    if (!Number.isFinite(feeCents)) return { ok: false };
    const { error } = await db
      .from("application_form_requests")
      .update({ fee_cents: feeCents, updated_at: new Date().toISOString() })
      .eq("id", request.id)
      .is("fee_cents", null);
    if (error) return { ok: false };
    return { ok: true, request: { ...request, fee_cents: feeCents } };
  } catch {
    return { ok: false };
  }
}

/**
 * Records one paid linked-form fee Checkout: the request's paid flags (paid-sticky: a later session never
 * unpays or re-attributes it) and the money in the ledger. The ledger booking is write-through and idempotent on
 * the Checkout session id, so a webhook replay, the payer's own verify, and a second real payment each book
 * exactly once. Shared by the webhook and the payer's verify so a payer who closes the tab is still recorded.
 */
export async function recordLinkedFormFeePayment(
  db: SupabaseClient,
  input: {
    request: LinkedFormRequestRow;
    session: Stripe.Checkout.Session;
    payerUserId: string;
    paidCents: number;
  },
): Promise<void> {
  const { request, session, payerUserId, paidCents } = input;
  const now = new Date().toISOString();
  const { error } = await db
    .from("application_form_requests")
    .update({
      fee_session_id: session.id,
      fee_paid_at: now,
      fee_paid_by_user_id: payerUserId,
      updated_at: now,
      ...(request.fee_cents === null ? { fee_cents: paidCents } : {}),
    })
    .eq("id", request.id)
    .is("fee_paid_at", null);
  if (error) throw new Error("Could not record the form fee payment.");

  const managerUserId = request.manager_user_id;
  const meta = session.metadata ?? {};
  const app = await loadApplicationAccessRow(db, request.application_id);
  const applicantRow = app ? (openApplicantRow(app.row_data, app.id, true, { soft: true }) as DemoApplicantRow) : null;
  const propertyId = meta.property_id?.trim() || (app ? String(app.assigned_property_id ?? app.property_id ?? "").trim() : "");
  const residentEmail = (meta.resident_email?.trim() || session.customer_email?.trim() || "").toLowerCase();
  const label = `$${(paidCents / 100).toFixed(2)}`;
  const chargeId = `hc_linked_form_fee_${session.id}`;
  // A replay keeps the first booking's date, so it never moves a payment between reporting periods.
  const { data: priorRow } = await db.from("portal_household_charge_records").select("row_data").eq("id", chargeId).maybeSingle();
  const priorPaidAt = (priorRow?.row_data as { paidAt?: string } | null | undefined)?.paidAt;
  const bookedAt = typeof priorPaidAt === "string" && priorPaidAt ? priorPaidAt : now;
  const charge: HouseholdCharge = {
    id: chargeId,
    createdAt: bookedAt,
    applicationId: request.application_id,
    residentEmail,
    residentName: residentEmail || "Form fee payer",
    residentUserId: payerUserId,
    propertyId,
    propertyLabel: String((applicantRow as { property?: string } | null)?.property ?? "").trim() || "Property",
    managerUserId,
    // `other_cost` books to other income; the `application_fee` kind is reserved for the applicant's own fee,
    // whose payment matching must never mistake this row for it.
    kind: "other_cost",
    title: "Form fee",
    amountLabel: label,
    balanceLabel: "$0.00",
    status: "paid",
    paidAt: bookedAt,
    paidAmountCents: paidCents,
    blocksLeaseUntilPaid: false,
  };
  const { error: upsertError } = await db.from("portal_household_charge_records").upsert(
    {
      id: charge.id,
      manager_user_id: managerUserId,
      resident_user_id: payerUserId,
      resident_email: residentEmail,
      property_id: propertyId,
      kind: charge.kind,
      status: "paid",
      row_data: { ...charge, stripeCheckoutSessionId: session.id, stripePaymentStatus: session.payment_status },
      updated_at: now,
    },
    { onConflict: "id" },
  );
  if (upsertError) throw new Error("Could not book the form fee payment.");
  await syncLedgerPaymentEntry(db, charge, bookedAt, session.id);
}

/**
 * Webhook settle for a paid linked-form fee Checkout. Bound to the metadata the server stamped at checkout
 * (purpose, request id, payer id, manager) and re-checked against the stored request, never to anything else.
 * Idempotent on replay.
 */
export async function markLinkedFormFeePaidFromStripeSession(
  db: SupabaseClient,
  session: Stripe.Checkout.Session,
): Promise<{ ok: boolean }> {
  const meta = session.metadata ?? {};
  if (meta.purpose !== LINKED_FORM_FEE_PURPOSE || !axisAchCheckoutPaid(session)) return { ok: false };
  const requestId = meta.linked_form_request_id?.trim() ?? "";
  const payerUserId = meta.payer_user_id?.trim() ?? "";
  if (!requestId || !payerUserId) return { ok: false };
  const request = await loadLinkedFormRequest(db, requestId);
  if (!request || request.form_kind !== "application") return { ok: false };
  if (!meta.manager_user_id || meta.manager_user_id.trim() !== request.manager_user_id) return { ok: false };
  const paidCents = Number(meta.fee_cents);
  if (!Number.isInteger(paidCents) || paidCents <= 0 || paidCents < (request.fee_cents ?? 0)) {
    console.error("[stripe webhook] linked form fee does not cover the request", { requestId });
    return { ok: false };
  }
  await recordLinkedFormFeePayment(db, { request, session, payerUserId, paidCents });
  return { ok: true };
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
  if (!Number.isInteger(paidCents) || paidCents <= 0 || paidCents < (input.request.fee_cents ?? 0)) {
    return { ok: false, status: 409, error: "That payment does not cover this form's fee." };
  }
  await recordLinkedFormFeePayment(db, {
    request: input.request,
    session,
    payerUserId: input.payerUserId,
    paidCents,
  });
  return { ok: true, paid: true };
}
