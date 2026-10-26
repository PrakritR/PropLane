import { NextResponse } from "next/server";
import { resolveSessionActorRole } from "@/lib/auth/vendor-api-access";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";
import { scheduleAssignedVisit } from "@/lib/work-order-bids.server";

export const runtime = "nodejs";

/** The vendor on a directly assigned job picks the visit time. The work order id is only a name:
 * `scheduleAssignedVisit` re-derives `vendor_user_id = actor` from the row. */
export async function POST(req: Request) {
  try {
    const db = createSupabaseServiceRoleClient();
    const auth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await auth.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    if ((await resolveAuthenticatedBusinessAccess(user.id, db)).kind === "denied") {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    const { data: profile } = await db.from("profiles").select("email, role, full_name").eq("id", user.id).maybeSingle();
    const actor = {
      userId: user.id,
      email: (profile?.email ?? user.email ?? "").trim().toLowerCase(),
      fullName: profile?.full_name?.trim() || "",
      admin: false,
      role: await resolveSessionActorRole(profile?.role ?? user.user_metadata?.role),
    };

    const body = (await req.json().catch(() => ({}))) as { workOrderId?: string; visitAt?: string };
    const result = await scheduleAssignedVisit(db, actor, body);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ ok: true, workOrder: result.workOrder, scheduledAtIso: result.scheduledAtIso });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not schedule the visit." }, { status: 500 });
  }
}
