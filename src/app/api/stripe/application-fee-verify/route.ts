import { NextResponse } from "next/server";
import { ensureResidentSetupTokenForApplication } from "@/lib/auth/resident-setup-token";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { applicationSubmittedEmailSubject, buildApplicationSubmittedEmailBody, buildApplicationSubmittedEmailHtml } from "@/lib/application-submitted-email";
import { shouldSkipOutboundEmail } from "@/lib/portal-sandbox-accounts";
import { rateLimit } from "@/lib/rate-limit";
import { postResendEmail } from "@/lib/resend-delivery.server";
import { residentAccountCreationUrl } from "@/lib/resident-welcome-email";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe";
import { axisAchCheckoutPaid, axisAchCheckoutProcessing } from "@/lib/stripe-axis-ach-checkout";
import { promoteIncompleteApplicationAfterFeePaid } from "@/lib/promote-incomplete-application-after-fee.server";
import { reportOrphanedApplicationFeePayment } from "@/lib/report-orphaned-application-fee.server";
import {
  includesHoldingDeposit,
  isApplicationFeeCheckoutSession,
  markApplicationDepositPaidFromStripeSession,
  markApplicationFeePaidFromStripeSession,
} from "@/lib/stripe-application-fee";

export const runtime = "nodejs";

function normalizedEmail(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

type Body = {
  sessionId?: string;
  expectedEmail?: string;
};

/**
 * Confirms a completed Checkout Session for `rental_application_fee` (ACH return URL flow).
 *
 * The caller POSTs the email it believes bought the session and gets back only
 * `emailMatches`. This endpoint is unauthenticated, so the applicant's address
 * is never echoed in the response — and it travels in the request BODY rather
 * than the query string, which CDN/proxy/APM access logs record verbatim.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Body;
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  const expectedEmail = normalizedEmail(body.expectedEmail);
  if (!sessionId) {
    return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
  }

  try {
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (!isApplicationFeeCheckoutSession(session)) {
      return NextResponse.json({ error: "Not an application fee checkout session." }, { status: 400 });
    }

    const paid = axisAchCheckoutPaid(session);
    const processing = axisAchCheckoutProcessing(session);

    if (!paid && !processing) {
      return NextResponse.json(
        {
          paid: false,
          processing: false,
          paymentStatus: session.payment_status,
          status: session.status,
          error: "Payment is not completed yet. Wait a moment and try again.",
        },
        { status: 200 },
      );
    }

    let chargeId: string | null = null;
    let alreadyPaid = false;
    let depositChargeId: string | null = null;
    let applicationPromoted = false;
    let applicationAxisId: string | null = null;
    let applicationSetupToken: string | null = null;
    // Lead review follow-up (2026-09-27): set only when the draft's CURRENT
    // application template no longer matches what this session paid for, and
    // the amount paid doesn't cover what that current template now requires.
    // The client must refuse to finalize the submission on this signal
    // instead of trusting a bare `paid: true` — see
    // `promoteIncompleteApplicationAfterFeePaid`'s `fee_mismatch` reason.
    let feeMismatch: { requiredCents: number; paidCents: number } | null = null;
    let applicationSetupEmailSent = session.metadata?.application_setup_email_sent === "1";
    if (paid) {
      const db = createSupabaseServiceRoleClient();
      const result = await markApplicationFeePaidFromStripeSession(db, session);
      chargeId = result.chargeId ?? null;
      alreadyPaid = result.alreadyPaid ?? false;
      // A combined checkout (application fee + holding deposit) is ONE Stripe
      // session but TWO charge rows server-side — this route is the ACH/redirect
      // return path, so it must mark both, same as the webhook does for the
      // synchronous card path.
      if (includesHoldingDeposit(session)) {
        const depositResult = await markApplicationDepositPaidFromStripeSession(db, session);
        depositChargeId = depositResult.chargeId ?? null;
      }
      // PRP-431: promote Incomplete → Submitted from the draft snapshot so a
      // wiped client form after Stripe return cannot leave the app stuck.
      const promoted = await promoteIncompleteApplicationAfterFeePaid(db, session);
      if (promoted.ok && promoted.promoted) {
        applicationPromoted = true;
        applicationAxisId = promoted.axisId;
        applicationSetupToken = promoted.setupToken ?? null;
      } else if (promoted.ok && promoted.reason === "already_submitted") {
        applicationPromoted = true;
        applicationAxisId = promoted.axisId ?? null;
      } else if (promoted.ok && promoted.reason === "fee_mismatch") {
        feeMismatch = { requiredCents: promoted.requiredCents, paidCents: promoted.paidCents };
      }
      if (!applicationPromoted) {
        // A public return intentionally knows only the session id. Report with
        // Stripe's stored identity server-side; never ask the browser for it or
        // weaken the public orphan-report endpoint's email check.
        const sessionEmail = normalizedEmail(session.metadata?.resident_email ?? session.customer_email);
        if (sessionEmail.includes("@")) {
          try {
            const report = await reportOrphanedApplicationFeePayment(db, { sessionId: session.id, expectedEmail: sessionEmail });
            if (!report.ok) console.warn("[application-fee-verify] orphan_report_failed");
          } catch {
            // Payment is still durable; verification can retry reporting.
            console.warn("[application-fee-verify] orphan_report_failed");
          }
        }
      }
      // Hosted/native returns can lose both the browser cookie and resume data.
      // Deliver only to the saved application's address, including webhook-first
      // promotion; a session id never authorizes disclosing its claim token.
      const apiKey = process.env.RESEND_API_KEY?.trim();
      if (applicationPromoted && applicationAxisId && !applicationSetupEmailSent && apiKey) {
        try {
          // Serializes ordinary polling and bounds token rotation if delivery or
          // the Stripe marker fails. Failed attempts can retry after one minute.
          const allowed = await rateLimit(`application-fee-setup-email:${session.id}`, 1, 60_000);
          if (allowed.ok) {
            const ensured = await ensureResidentSetupTokenForApplication(db, applicationAxisId, {
              managerUserId: session.metadata?.manager_user_id,
              preferredToken: applicationSetupToken,
            });
            if (ensured.ok && ensured.row.managerUserId?.trim()) {
              applicationSetupToken = ensured.token;
              const accountReady = Boolean(ensured.row.residentUserId?.trim());
              const origin = resolveEmailLinkBaseUrl();
              const content = {
                applicantName: ensured.row.name,
                applicantEmail: ensured.email,
                axisId: ensured.axisId,
                signupUrl: accountReady ? `${origin}/resident/applications` : residentAccountCreationUrl(origin, ensured.axisId, ensured.token),
                propertyTitle: ensured.row.property,
                accountReady,
              };
              const delivery = shouldSkipOutboundEmail(ensured.email) ? null : await postResendEmail({
                apiKey,
                actorUserId: ensured.row.managerUserId,
                payload: {
                  from: process.env.RESEND_FROM?.trim() || "PropLane <onboarding@resend.dev>",
                  to: [ensured.email],
                  subject: applicationSubmittedEmailSubject(accountReady),
                  text: buildApplicationSubmittedEmailBody(content),
                  html: buildApplicationSubmittedEmailHtml(content),
                },
                effectSummary: "Paid application setup email captured for the test workspace.",
                metadata: { applicationId: ensured.axisId },
                signal: AbortSignal.timeout(10_000),
              });
              if (!delivery || delivery.ok) {
                applicationSetupEmailSent = true;
                await stripe.checkout.sessions.update(session.id, {
                  metadata: { application_setup_email_sent: "1" },
                });
              }
            }
          }
        } catch {
          // Payment/application success remains durable. No identity or token is
          // logged; a later verification retries an unsuccessful email attempt.
          console.warn("[application-fee-verify] setup_email_delivery_failed");
        }
      }
    }

    return NextResponse.json({
      paid,
      processing,
      paymentStatus: session.payment_status,
      sessionId: session.id,
      propertyId: session.metadata?.property_id ?? null,
      emailMatches:
        expectedEmail.length > 0 &&
        expectedEmail === normalizedEmail(session.metadata?.resident_email ?? session.customer_email),
      chargeId,
      alreadyPaid,
      depositChargeId,
      applicationPromoted,
      applicationAxisId,
      applicationSetupEmailSent,
      // A checkout can be started with an arbitrary email. Its session id or
      // browser cookie never proves ownership of the saved application, so the
      // claim link is delivered only to the application's stored email — never
      // the raw applicationSetupToken, which this response must not echo.
      ...(feeMismatch
        ? {
            feeMismatch: true,
            requiredCents: feeMismatch.requiredCents,
            paidCents: feeMismatch.paidCents,
            error: `This application now requires a $${(feeMismatch.requiredCents / 100).toFixed(2)} fee — $${(
              feeMismatch.paidCents / 100
            ).toFixed(2)} was paid. Pay the difference before submitting.`,
          }
        : {}),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to verify session";
    if (message.includes("STRIPE_SECRET_KEY") || message.includes("Missing STRIPE")) {
      return NextResponse.json({ error: "Stripe is not configured on the server." }, { status: 503 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
