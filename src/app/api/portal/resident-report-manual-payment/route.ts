import { NextResponse } from "next/server";
import { authorizeResidentRole } from "@/lib/auth/resident-role-access";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { reportResidentManualPayment } from "@/lib/resident-manual-payment.server";

export const runtime = "nodejs";

type Body = {
  chargeIds?: string[];
  channel?: "zelle" | "venmo";
};

/**
 * Resident reports having sent a manual (Zelle/Venmo) payment. The ownership
 * re-checks + charge patch + manager notification live in
 * `@/lib/resident-manual-payment.server` (shared with the resident agent's
 * report_manual_payment tool); this route only authenticates and maps the
 * result onto HTTP responses.
 */
export async function POST(req: Request) {
  try {
    const auth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await auth.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    }

    const db = createSupabaseServiceRoleClient();
    const { data: profile } = await db.from("profiles").select("role, email").eq("id", user.id).maybeSingle();
    const legacyRole = String(profile?.role ?? user.user_metadata?.role ?? "").trim().toLowerCase();
    if (!(await authorizeResidentRole(db, { userId: user.id, legacyRole }))) {
      return NextResponse.json({ error: "Residents only." }, { status: 403 });
    }

    const body = (await req.json()) as Body;
    const channel = body.channel === "venmo" ? "venmo" : body.channel === "zelle" ? "zelle" : null;
    if (!channel) {
      return NextResponse.json({ error: "channel must be zelle or venmo." }, { status: 400 });
    }

    const chargeIds = (Array.isArray(body.chargeIds) ? body.chargeIds : []).filter(
      (id): id is string => typeof id === "string",
    );
    const result = await reportResidentManualPayment(db, {
      userId: user.id,
      userEmail: (profile?.email ?? user.email ?? "").trim().toLowerCase(),
      chargeIds,
      channel,
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ ok: true, charges: result.charges });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to report manual payment.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
