import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { backfillGlFromSources, repairManualEntryGl } from "@/lib/reports/gl-posting";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/**
 * One-time/historical repair: posts GL journal entries for existing ledger and
 * expense rows. Never called automatically — run manually per environment after
 * deploying Phase 1 GL posting (see AGENTS.md).
 */
export async function POST(req: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    if (!(await isAdminUser(user.id))) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const body = (await req.json().catch(() => ({}))) as { managerUserId?: string; manualOnly?: boolean; dryRun?: boolean };
    const managerUserId = body.managerUserId?.trim() || undefined;

    const db = createSupabaseServiceRoleClient();
    // `manualOnly` / `dryRun`: the manual-entry repair alone (idempotent), optionally reporting what it would post.
    if (body.manualOnly || body.dryRun) {
      return NextResponse.json({ ok: true, ...(await repairManualEntryGl(db, { managerUserId, dryRun: body.dryRun === true })) });
    }
    const result = await backfillGlFromSources(db, managerUserId);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to backfill GL.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
