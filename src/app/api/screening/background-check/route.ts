/**
 * Run / refresh a Checkr criminal background check for an applicant.
 *
 * Security: the Checkr key stays server-side (in the lib client). The manager
 * is authenticated from the session cookie and may only act on applications
 * they own, are linked to by property, or an admin. `managerUserId` is derived
 * from the record, never from model/client input.
 */
import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { collectLinkedPropertyIdsForUser } from "@/lib/auth/manager-lease-scope";
import { track } from "@/lib/analytics/posthog";
import {
  refreshBackgroundCheck,
  refreshCosignerBackgroundCheck,
  runBackgroundCheck,
  runCosignerBackgroundCheck,
} from "@/lib/checkr/background-check";
import { checkrSkipsManagerCardCharge } from "@/lib/checkr/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

type Body = {
  applicationId?: string;
  cosignerSubmissionId?: string;
  action?: "run" | "refresh";
  packageSlug?: string;
  addOnProducts?: string[];
};

export async function POST(req: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const body = (await req.json()) as Body;
    const applicationId = body.applicationId?.trim();
    const cosignerSubmissionId = body.cosignerSubmissionId?.trim();
    const action = body.action === "refresh" ? "refresh" : "run";
    if (!applicationId && !cosignerSubmissionId) {
      return NextResponse.json({ error: "applicationId or cosignerSubmissionId is required." }, { status: 400 });
    }
    if (cosignerSubmissionId && !cosignerSubmissionId.startsWith("cosigner-")) {
      return NextResponse.json({ error: "Invalid co-signer submission id." }, { status: 400 });
    }

    // Live screening orders are prepaid via Stripe Checkout
    // (`/api/screening/checkout` → webhook). Direct "run" stays available only
    // in pure simulate mode so payment can never be skipped.
    if (action === "run" && !checkrSkipsManagerCardCharge()) {
      return NextResponse.json(
        { error: "Screening orders must be paid via Stripe Checkout first.", code: "payment_required" },
        { status: 402 },
      );
    }

    const db = createSupabaseServiceRoleClient();
    const admin = await isAdminUser(user.id);

    let managerUserId: string | undefined;
    if (cosignerSubmissionId) {
      const { data: cosignerRecord } = await db
        .from("cosigner_submission_records")
        .select("manager_user_id, signer_app_id")
        .eq("id", cosignerSubmissionId)
        .maybeSingle();
      if (!cosignerRecord) {
        return NextResponse.json({ error: "Co-signer submission not found." }, { status: 404 });
      }
      const signerAppId = String(cosignerRecord.signer_app_id ?? "").trim();
      const { data: record } = await db
        .from("manager_application_records")
        .select("manager_user_id, property_id, assigned_property_id, row_data")
        .eq("id", signerAppId)
        .maybeSingle();
      managerUserId =
        record?.manager_user_id?.trim() ||
        (record?.row_data as { managerUserId?: string } | null)?.managerUserId?.trim() ||
        String(cosignerRecord.manager_user_id ?? "").trim();
      if (!managerUserId) {
        return NextResponse.json({ error: "Application has no assigned manager." }, { status: 400 });
      }
      if (!admin && managerUserId !== user.id) {
        const linked = await collectLinkedPropertyIdsForUser(db, user.id);
        const propertyId = String(record?.property_id ?? "").trim();
        const assignedPropertyId = String(record?.assigned_property_id ?? "").trim();
        if (!((propertyId && linked.has(propertyId)) || (assignedPropertyId && linked.has(assignedPropertyId)))) {
          return NextResponse.json({ error: "Forbidden." }, { status: 403 });
        }
      }
    } else {
      const { data: record } = await db
        .from("manager_application_records")
        .select("manager_user_id, property_id, assigned_property_id, row_data")
        .eq("id", applicationId!)
        .maybeSingle();

      managerUserId =
        record?.manager_user_id?.trim() ||
        (record?.row_data as { managerUserId?: string } | null)?.managerUserId?.trim();
      if (!managerUserId) {
        return NextResponse.json({ error: "Application has no assigned manager." }, { status: 400 });
      }
      if (!admin && managerUserId !== user.id) {
        const linked = await collectLinkedPropertyIdsForUser(db, user.id);
        const propertyId = String(record?.property_id ?? "").trim();
        const assignedPropertyId = String(record?.assigned_property_id ?? "").trim();
        if (!((propertyId && linked.has(propertyId)) || (assignedPropertyId && linked.has(assignedPropertyId)))) {
          return NextResponse.json({ error: "Forbidden." }, { status: 403 });
        }
      }
    }

    const result = cosignerSubmissionId
      ? action === "refresh"
        ? await refreshCosignerBackgroundCheck({ db, cosignerSubmissionId, managerUserId })
        : await runCosignerBackgroundCheck({
            db,
            cosignerSubmissionId,
            managerUserId,
            packageSlug: body.packageSlug,
            addOnProducts: body.addOnProducts,
          })
      : action === "refresh"
        ? await refreshBackgroundCheck({ db, applicationId: applicationId!, managerUserId })
        : await runBackgroundCheck({
            db,
            applicationId: applicationId!,
            managerUserId,
            packageSlug: body.packageSlug,
            addOnProducts: body.addOnProducts,
          });
    if (!result.ok) {
      return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
    }

    // Server-confirmed analytics — ids/enums only, no PII.
    const bc = result.backgroundCheck;
    if (action === "run") {
      track("background_check_started", managerUserId, { provider: bc.provider });
    }
    if (bc.status === "complete" && bc.result) {
      track("background_check_completed", managerUserId, { provider: bc.provider, result: bc.result });
    }

    return NextResponse.json({
      ok: true,
      backgroundCheck: bc,
      row: "row" in result ? result.row : undefined,
      cosignerSubmission: "submission" in result ? result.submission : undefined,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to run background check.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
