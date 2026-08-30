/**
 * Confirms a screening Checkout Session after embedded payment and places the
 * Checkr order when the webhook has not landed yet. Idempotent via
 * runBackgroundCheck's prepaid session guard.
 */
import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { collectLinkedPropertyIdsForUser } from "@/lib/auth/manager-lease-scope";
import { runBackgroundCheck, runCosignerBackgroundCheck } from "@/lib/checkr/background-check";
import { isCheckrAddOn, isCheckrPackage, type CheckrAddOnSlug } from "@/lib/checkr/packages";
import type { CheckrPackage } from "@/lib/checkr/config";
import { isScreeningCheckoutSession } from "@/lib/stripe-screening";
import { getStripe } from "@/lib/stripe";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

type Body = { sessionId?: string };

export async function POST(req: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const body = (await req.json()) as Body;
    const sessionId = body.sessionId?.trim();
    if (!sessionId) return NextResponse.json({ error: "sessionId is required." }, { status: 400 });

    const stripe = getStripe();
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (!isScreeningCheckoutSession(session)) {
      return NextResponse.json({ error: "Not a screening checkout session." }, { status: 400 });
    }

    const applicationId = session.metadata?.application_id?.trim();
    const cosignerSubmissionId = session.metadata?.cosigner_submission_id?.trim();
    const managerUserId = session.metadata?.manager_user_id?.trim();
    if (!applicationId || !managerUserId) {
      return NextResponse.json({ error: "Checkout session is missing screening metadata." }, { status: 400 });
    }

    const db = createSupabaseServiceRoleClient();
    const admin = await isAdminUser(user.id);
    if (!admin && managerUserId !== user.id) {
      const { data: record } = await db
        .from("manager_application_records")
        .select("property_id, assigned_property_id")
        .eq("id", applicationId)
        .maybeSingle();
      const linked = await collectLinkedPropertyIdsForUser(db, user.id);
      const propertyId = String(record?.property_id ?? "").trim();
      const assignedPropertyId = String(record?.assigned_property_id ?? "").trim();
      if (!((propertyId && linked.has(propertyId)) || (assignedPropertyId && linked.has(assignedPropertyId)))) {
        return NextResponse.json({ error: "Forbidden." }, { status: 403 });
      }
    }

    const paid = session.payment_status === "paid" || session.payment_status === "no_payment_required";
    if (!paid) {
      return NextResponse.json(
        {
          paid: false,
          paymentStatus: session.payment_status,
          status: session.status,
          error: "Payment is not completed yet.",
        },
        { status: 200 },
      );
    }

    const { data: existingRecord } = cosignerSubmissionId
      ? await db
          .from("cosigner_submission_records")
          .select("row_data")
          .eq("id", cosignerSubmissionId)
          .maybeSingle()
      : await db
          .from("manager_application_records")
          .select("row_data")
          .eq("id", applicationId)
          .maybeSingle();
    const existingRow = existingRecord?.row_data as {
      backgroundCheck?: { stripeCheckoutSessionId?: string };
    } | null;
    if (existingRow?.backgroundCheck?.stripeCheckoutSessionId === session.id) {
      return NextResponse.json({
        paid: true,
        sessionId: session.id,
        backgroundCheck: existingRow.backgroundCheck,
      });
    }

    const paymentIntentId =
      typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
    const rawPackageSlug = session.metadata?.package_slug ?? "";
    const packageSlug: CheckrPackage = isCheckrPackage(rawPackageSlug) ? rawPackageSlug : "essential";
    const addOnProducts = (session.metadata?.add_on_products ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(isCheckrAddOn) as CheckrAddOnSlug[];

    const result = cosignerSubmissionId
      ? await runCosignerBackgroundCheck({
          db,
          cosignerSubmissionId,
          managerUserId,
          packageSlug,
          addOnProducts,
          prepaid: { checkoutSessionId: session.id, paymentIntentId },
        })
      : await runBackgroundCheck({
          db,
          applicationId,
          managerUserId,
          packageSlug,
          addOnProducts,
          prepaid: { checkoutSessionId: session.id, paymentIntentId },
        });

    if (!result.ok) {
      return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
    }

    return NextResponse.json({
      paid: true,
      sessionId: session.id,
      backgroundCheck: result.backgroundCheck,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to verify screening payment.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
