import { NextResponse } from "next/server";

import { getManagerServiceFeePayerByManagerId } from "@/lib/manager-access-server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";

export const runtime = "nodejs";

/**
 * Who pays the online payment service fee for the authenticated resident's
 * manager — used for pre-checkout disclosure so the resident sees the truth
 * (any fee, or none) before paying. Read-only; the checkout session remains the
 * authoritative amount. Scoped to the resident's own `profiles.manager_id`, so a
 * resident can only learn their own manager's setting.
 */
export async function GET() {
  try {
    const auth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await auth.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    }

    const db = createSupabaseServiceRoleClient();
    if ((await resolveAuthenticatedBusinessAccess(user.id, db)).kind === "denied") {
      return NextResponse.json({ error: "Payment access is unavailable for this account." }, { status: 403 });
    }
    const { data: profile } = await db
      .from("profiles")
      .select("manager_id")
      .eq("id", user.id)
      .maybeSingle();

    const managerId = String(profile?.manager_id ?? "").trim();
    const serviceFeePayer = managerId
      ? await getManagerServiceFeePayerByManagerId(managerId)
      : "resident";

    return NextResponse.json({ serviceFeePayer });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
