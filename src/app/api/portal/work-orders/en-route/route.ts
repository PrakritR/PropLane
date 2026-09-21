import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";
import { markVendorEnRoute } from "@/lib/work-order-en-route.server";

export const runtime = "nodejs";

/** Vendor's "On my way" tap. The resident is texted once; a repeat tap is a no-op. */
export async function POST(req: Request) {
  try {
    const db = createSupabaseServiceRoleClient();
    const auth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await auth.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    if ((await resolveAuthenticatedBusinessAccess(user.id, db)).kind === "denied") {
      return NextResponse.json({ error: "Work order access is unavailable for this account." }, { status: 403 });
    }
    const admin = await isAdminUser(user.id);
    const { data: profile } = await db.from("profiles").select("email, role, full_name").eq("id", user.id).maybeSingle();
    const actor = {
      userId: user.id,
      email: (profile?.email ?? user.email ?? "").trim().toLowerCase(),
      fullName: profile?.full_name?.trim() || "",
      admin,
      role: String(profile?.role ?? user.user_metadata?.role ?? "").toLowerCase(),
    };
    const body = (await req.json().catch(() => ({}))) as { workOrderId?: string; etaMinutes?: number };
    const result = await markVendorEnRoute(db, actor, body);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ ok: true, alreadyEnRoute: result.alreadyEnRoute, workOrder: result.workOrder });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not mark on the way." }, { status: 500 });
  }
}
