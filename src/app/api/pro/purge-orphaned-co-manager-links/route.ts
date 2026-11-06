import { resolveAdminOversight } from "@/lib/auth/admin-oversight.server";
import { NextResponse } from "next/server";
import { purgeOrphanedCoManagerLinks } from "@/lib/auth/purge-orphaned-co-manager-links";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const auth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await auth.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const db = createSupabaseServiceRoleClient();
    const { data: roleRows, error: roleError } = await db.from("profile_roles").select("role").eq("user_id", user.id);
    if (roleError) return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    const admin = (roleRows ?? []).some((row) => row.role === "admin");
    if (!admin && !(roleRows ?? []).some((row) => row.role === "manager")) return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    const oversight = await resolveAdminOversight(req, user.id, admin);

    const result = await purgeOrphanedCoManagerLinks(db, { managerUserId: oversight ? null : user.id });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to purge orphaned co-manager links.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
