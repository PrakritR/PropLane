import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { purgeManagerResidentOrphans } from "@/lib/auth/purge-manager-resident-orphans";
import { purgeOrphanedPortalRecords } from "@/lib/auth/purge-orphaned-portal-records";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

function canManage(role: string, isAdmin: boolean) {
  return isAdmin || role === "manager" || role === "owner";
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as { mode?: unknown } | null;
    const mode = typeof body?.mode === "string" ? body.mode.trim().toLowerCase() : "current_only";

    const auth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await auth.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const db = createSupabaseServiceRoleClient();
    const [{ data: profile }, admin] = await Promise.all([
      db.from("profiles").select("role").eq("id", user.id).maybeSingle(),
      isAdminUser(user.id),
    ]);
    const role = String(profile?.role ?? "").toLowerCase();
    if (!canManage(role, admin)) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    if (mode === "admin_global") {
      if (!admin) {
        return NextResponse.json({ error: "Forbidden." }, { status: 403 });
      }
      const result = await purgeOrphanedPortalRecords(db);
      return NextResponse.json({ ok: true, ...result });
    }

    const result = await purgeManagerResidentOrphans(db, user.id, {
      currentOnly: mode === "current_only",
    });

    return NextResponse.json({
      ok: true,
      deleted: result.deleted,
      purgedEmails: result.purgedEmails,
      deletedApplicationIds: result.deletedApplicationIds,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to purge orphaned records.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
