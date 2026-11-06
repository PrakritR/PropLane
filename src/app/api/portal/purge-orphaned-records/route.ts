import { NextResponse } from "next/server";
import { purgeManagerResidentOrphans } from "@/lib/auth/purge-manager-resident-orphans";
import { purgeOrphanedPortalRecords } from "@/lib/auth/purge-orphaned-portal-records";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";

export const runtime = "nodejs";

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
    if ((await resolveAuthenticatedBusinessAccess(user.id, db)).kind === "denied") {
      return NextResponse.json({ error: "Portal access is unavailable for this account." }, { status: 403 });
    }
    const { data: roleRows, error: roleError } = await db.from("profile_roles").select("role").eq("user_id", user.id);
    if (roleError) return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    const admin = (roleRows ?? []).some((row) => row.role === "admin");

    // The platform-wide purge is the admin capability; the per-manager purge is the manager one. A
    // stored `admin` row is NOT read as a manager row (`AGENTS.md` § "Admin borrows"), so an
    // admin-only account can no longer run the manager branch against its own empty portfolio.
    if (mode === "admin_global") {
      if (!admin) {
        return NextResponse.json({ error: "Forbidden." }, { status: 403 });
      }
      const result = await purgeOrphanedPortalRecords(db);
      return NextResponse.json({ ok: true, ...result });
    }

    if (!(roleRows ?? []).some((row) => row.role === "manager")) return NextResponse.json({ error: "Forbidden." }, { status: 403 });

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
