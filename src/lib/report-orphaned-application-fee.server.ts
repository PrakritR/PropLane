/**
 * PRP-428 — when Stripe collected the application fee but the wizard could not
 * upsert a Submitted application, ensure the paid charge exists server-side and
 * notify the manager so the money is actionable without relying on the
 * applicant forwarding a receipt.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { notifyManagerFromAgent } from "@/lib/agent-notify.server";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { isDraftShapedApplicationRow } from "@/lib/rental-application/draft-shape";
import { isWithdrawnApplicationRow } from "@/lib/rental-application/resident-application-list";
import { promoteIncompleteApplicationAfterFeePaid } from "@/lib/promote-incomplete-application-after-fee.server";
import { getStripe } from "@/lib/stripe";
import {
  isApplicationFeeCheckoutSession,
  markApplicationFeePaidFromStripeSession,
} from "@/lib/stripe-application-fee";
import { axisAchCheckoutPaid } from "@/lib/stripe-axis-ach-checkout";
import type { HouseholdCharge } from "@/lib/household-charges";

function normalizedEmail(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function rowIsSubmittedApplication(row: DemoApplicantRow): boolean {
  if (isWithdrawnApplicationRow(row)) return false;
  if (isDraftShapedApplicationRow(row)) return false;
  return true;
}

export async function hasSubmittedApplicationForFee(
  db: SupabaseClient,
  input: { residentEmail: string; propertyId: string },
): Promise<boolean> {
  const email = normalizedEmail(input.residentEmail);
  const propertyId = input.propertyId.trim();
  if (!email.includes("@") || !propertyId) return false;

  const { data, error } = await db
    .from("manager_application_records")
    .select("row_data, property_id, assigned_property_id")
    .eq("resident_email", email)
    .order("updated_at", { ascending: false })
    .limit(25);
  if (error) throw new Error(error.message);

  return (data ?? []).some((row) => {
    const app = (row.row_data ?? {}) as DemoApplicantRow;
    if (!rowIsSubmittedApplication(app)) return false;
    const pid =
      String(row.assigned_property_id ?? "").trim() ||
      String(row.property_id ?? "").trim() ||
      app.assignedPropertyId?.trim() ||
      app.propertyId?.trim() ||
      app.application?.propertyId?.trim() ||
      "";
    return pid.toLowerCase() === propertyId.toLowerCase();
  });
}

export type OrphanedApplicationFeeReportResult =
  | {
      ok: true;
      notified: boolean;
      chargeId: string | null;
      reason?: "application_exists" | "suppressed" | "no_manager" | "promoted";
    }
  | { ok: false; status: number; error: string };

/**
 * Re-verifies the Checkout session server-side, ensures a paid fee charge, and
 * notifies the manager when no Submitted application exists for that email+listing.
 * Idempotent on session id (inbox message + SMS dedupe).
 *
 * PRP-431: tries to promote Incomplete → Submitted from the draft snapshot
 * before notifying about an orphan.
 */
export async function reportOrphanedApplicationFeePayment(
  db: SupabaseClient,
  input: { sessionId: string; expectedEmail: string },
): Promise<OrphanedApplicationFeeReportResult> {
  const sessionId = input.sessionId.trim();
  const expectedEmail = normalizedEmail(input.expectedEmail);
  if (!sessionId) {
    return { ok: false, status: 400, error: "Missing sessionId" };
  }
  if (!expectedEmail.includes("@")) {
    return { ok: false, status: 400, error: "Missing expectedEmail" };
  }

  let session;
  try {
    const stripe = getStripe();
    session = await stripe.checkout.sessions.retrieve(sessionId);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load checkout session";
    if (message.includes("STRIPE_SECRET_KEY") || message.includes("Missing STRIPE")) {
      return { ok: false, status: 503, error: "Stripe is not configured on the server." };
    }
    return { ok: false, status: 400, error: "Could not verify payment session." };
  }

  if (!isApplicationFeeCheckoutSession(session) || !axisAchCheckoutPaid(session)) {
    return { ok: false, status: 400, error: "Payment is not completed for this session." };
  }

  const sessionEmail = normalizedEmail(session.metadata?.resident_email ?? session.customer_email);
  if (!sessionEmail || sessionEmail !== expectedEmail) {
    return { ok: false, status: 403, error: "Payment confirmation does not match this email." };
  }

  const propertyId = session.metadata?.property_id?.trim() ?? "";
  const managerUserId = session.metadata?.manager_user_id?.trim() ?? "";
  if (!propertyId) {
    return { ok: false, status: 400, error: "Checkout session is missing listing metadata." };
  }

  const marked = await markApplicationFeePaidFromStripeSession(db, session);
  if (!marked.ok) {
    return { ok: false, status: 500, error: "Could not record the application fee payment." };
  }

  const promoted = await promoteIncompleteApplicationAfterFeePaid(db, session);
  if (promoted.ok && (promoted.promoted || promoted.reason === "already_submitted")) {
    return {
      ok: true,
      notified: false,
      chargeId: marked.chargeId ?? null,
      reason: promoted.promoted ? "promoted" : "application_exists",
    };
  }

  if (await hasSubmittedApplicationForFee(db, { residentEmail: expectedEmail, propertyId })) {
    return {
      ok: true,
      notified: false,
      chargeId: marked.chargeId ?? null,
      reason: "application_exists",
    };
  }

  const landlordId =
    managerUserId ||
    (await db
      .from("portal_household_charge_records")
      .select("manager_user_id")
      .eq("id", marked.chargeId ?? "")
      .maybeSingle()
      .then((r) => (typeof r.data?.manager_user_id === "string" ? r.data.manager_user_id.trim() : "")));

  if (!landlordId) {
    return { ok: true, notified: false, chargeId: marked.chargeId ?? null, reason: "no_manager" };
  }

  let amountLabel = "";
  if (marked.chargeId) {
    const { data: chargeRow } = await db
      .from("portal_household_charge_records")
      .select("row_data")
      .eq("id", marked.chargeId)
      .maybeSingle();
    const charge = chargeRow?.row_data as HouseholdCharge | null;
    amountLabel = charge?.amountLabel?.trim() || "";
  }
  if (!amountLabel && typeof session.amount_total === "number" && session.amount_total > 0) {
    amountLabel = `$${(session.amount_total / 100).toFixed(2)}`;
  }

  const residentName = session.metadata?.resident_name?.trim() || "Applicant";
  const origin = resolveEmailLinkBaseUrl().replace(/\/$/, "");
  const subject = "Application fee paid — application not submitted";
  const text = [
    `${residentName} paid the rental application fee, but PropLane could not save their application.`,
    "",
    `Applicant email: ${expectedEmail}`,
    `Listing id: ${propertyId}`,
    amountLabel ? `Fee amount: ${amountLabel}` : null,
    `Stripe checkout session: ${sessionId}`,
    marked.chargeId ? `Charge id: ${marked.chargeId}` : null,
    "",
    "The fee is recorded as paid under Payments. Contact the applicant to finish their application or arrange a refund if needed.",
    `${origin}/portal/payments`,
    "",
    "— PropLane",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");

  const result = await notifyManagerFromAgent(db, {
    landlordId,
    subject,
    text,
    category: "applications",
    url: "/portal/payments",
    idempotencyKey: `orphan_app_fee_${sessionId}`,
    externalText: "An applicant paid the application fee but their application did not save. Open PropLane Payments.",
  });

  return {
    ok: true,
    notified: result.delivered,
    chargeId: marked.chargeId ?? null,
    reason: result.suppressed ? "suppressed" : undefined,
  };
}
