import { NextResponse } from "next/server";
import { cosignerSubmissionSummary } from "@/lib/cosigner-submission-visibility";
import { openCosignerIdentity } from "@/lib/security/cosigner-identity";
import type { CosignerSubmission } from "@/lib/cosigner-submissions-storage";
import { resolveAdminOversight } from "@/lib/auth/admin-oversight.server";
import { managerCanAccessApplicationRecord } from "@/lib/auth/manager-application-access";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const auth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await auth.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const url = new URL(req.url);
    const signerAppId = normalizeApplicationAxisId(url.searchParams.get("signerAppId")?.trim() ?? "");
    if (!signerAppId) return NextResponse.json({ error: "signerAppId required" }, { status: 400 });

    const db = createSupabaseServiceRoleClient();
    const admin = await resolveAdminOversight(req, user.id);

    let fullAccess = admin;
    if (!admin) {
      const { data: appRow } = await db
        .from("manager_application_records")
        .select("manager_user_id, resident_email, row_data, property_id, assigned_property_id")
        .eq("id", signerAppId)
        .maybeSingle();
      if (!appRow) return NextResponse.json({ error: "Forbidden." }, { status: 403 });

      const { data: roleRows, error: roleError } = await db.from("profile_roles").select("role").eq("user_id", user.id);
      if (roleError) return NextResponse.json({ error: "Forbidden." }, { status: 403 });
      const roles = (roleRows ?? []).map((row) => String(row.role ?? "").toLowerCase());
      const rowData = appRow.row_data && typeof appRow.row_data === "object" && !Array.isArray(appRow.row_data)
        ? appRow.row_data as Record<string, unknown> : {};
      const residentOwns = roles.includes("resident") && rowData.residentUserId === user.id;
      const managerOwns = roles.includes("manager") && await managerCanAccessApplicationRecord(db, user.id, appRow);
      const allowed = residentOwns || managerOwns;
      fullAccess = managerOwns;
      if (!allowed) return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const { data, error } = await db
      .from("cosigner_submission_records")
      .select("id, row_data, created_at")
      .eq("signer_app_id", signerAppId)
      .order("created_at", { ascending: true });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const rows = (data ?? [])
      .map((r) => {
        const rowData = r.row_data as CosignerSubmission | null;
        if (!rowData) return null;
        return fullAccess
          ? { ...openCosignerIdentity(rowData, String(r.id)), id: String(r.id) }
          : cosignerSubmissionSummary(rowData, String(r.id));
      })
      .filter(Boolean) as CosignerSubmission[];
    return NextResponse.json({ rows }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load co-signer submissions.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
