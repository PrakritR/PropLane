import { NextResponse } from "next/server";
import { resolveApplicationFeeProperty } from "@/lib/application-fee-checkout.server";
import { redeemApplicationFeeWaiverCode } from "@/lib/application-fee-waiver";
import { authorizeResidentRole } from "@/lib/auth/resident-role-access";
import { isResidentSetupTokenValid } from "@/lib/auth/resident-setup-token";
import { isDraftShapedApplicationRow } from "@/lib/rental-application/draft-shape";
import { isWithdrawnApplicationRow } from "@/lib/rental-application/resident-application-list";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

type Body = {
  propertyId?: string;
  managerUserId?: string;
  residentEmail?: string;
  applicationId?: string;
  setupToken?: string;
  code?: string;
};

/**
 * Validates AND atomically redeems a manager's application-fee waiver code
 * for one applicant, server-side only. This is the ONLY path that consumes a
 * code — there is no client-side check to bypass. `managerUserId` is
 * verified against the property's real stored owner (never trusted blindly).
 * The exact saved draft and its signed-in resident or guest setup token must
 * also match, so one application's redemption cannot waive another draft.
 * Rate-limited per IP to slow down code-guessing.
 */
export async function POST(req: Request) {
  try {
    if (!(await rateLimit(`application-fee-waiver:${clientIpFrom(req)}`, 10, 60_000)).ok) {
      return NextResponse.json({ error: "Too many requests. Please slow down." }, { status: 429 });
    }

    const body = (await req.json()) as Body;
    const propertyId = typeof body.propertyId === "string" ? body.propertyId.trim() : "";
    const managerUserId = typeof body.managerUserId === "string" ? body.managerUserId.trim() : "";
    const residentEmail = typeof body.residentEmail === "string" ? body.residentEmail.trim() : "";
    const code = typeof body.code === "string" ? body.code.trim() : "";
    const applicationId = typeof body.applicationId === "string" ? body.applicationId.trim() : "";

    if (!propertyId || !managerUserId || !residentEmail.includes("@") || !applicationId || !code) {
      return NextResponse.json(
        { error: "Save your application before applying a waiver code." },
        { status: 400 },
      );
    }

    const db = createSupabaseServiceRoleClient();
    const { data: application, error: applicationError } = await db.from("manager_application_records")
      .select("id,manager_user_id,property_id,resident_email,row_data")
      .eq("id", applicationId).maybeSingle();
    if (applicationError) throw applicationError;
    if (!application || !isDraftShapedApplicationRow(application.row_data ?? {}) ||
        isWithdrawnApplicationRow(application.row_data ?? {})) {
      return NextResponse.json({ error: "Your application is still saving. Try again shortly." }, { status: 409 });
    }
    if (application.manager_user_id !== managerUserId || application.property_id !== propertyId ||
        String(application.resident_email ?? "").trim().toLowerCase() !== residentEmail.toLowerCase()) {
      return NextResponse.json({ error: "This waiver does not match your saved application." }, { status: 403 });
    }
    const auth = await createSupabaseServerClient();
    const { data: { user } } = await auth.auth.getUser();
    let authorized = false;
    if (user?.email?.trim().toLowerCase() === residentEmail.toLowerCase()) {
      const { data: profile, error: profileError } = await db.from("profiles")
        .select("role").eq("id", user.id).maybeSingle();
      if (profileError) throw profileError;
      authorized = await authorizeResidentRole(db, { userId: user.id, legacyRole: profile?.role });
    }
    if (!authorized && typeof body.setupToken === "string") {
      authorized = isResidentSetupTokenValid(application.row_data ?? {}, body.setupToken);
    }
    if (!authorized) return NextResponse.json({ error: "Application access required before applying a waiver." }, { status: 403 });

    // Re-verify the property is really owned by this manager (the same guard
    // the checkout route applies) before touching that manager's codes.
    const resolved = await resolveApplicationFeeProperty(db, { propertyId, managerUserId });
    if (!resolved.ok) {
      return NextResponse.json({ error: resolved.error, code: resolved.code }, { status: resolved.status });
    }

    const result = await redeemApplicationFeeWaiverCode(db, {
      managerUserId,
      propertyId,
      residentEmail,
      applicationId,
      code,
    });

    if (!result.ok) {
      // 400 means "we checked and this code cannot be used". `UNAVAILABLE`
      // means we never got to check, so it must not be a client error — the
      // applicant is told to retry rather than that their code is bad.
      const status = result.reason === "UNAVAILABLE" ? 503 : 400;
      return NextResponse.json({ error: result.error, code: result.reason }, { status });
    }

    return NextResponse.json({ ok: true, waived: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not apply that code.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
