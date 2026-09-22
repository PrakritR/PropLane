import { NextResponse } from "next/server";

import { isProductionRuntime } from "@/lib/server-env";
import { listManagersWithSheetLinks } from "@/lib/manager-sheet-link";
import { syncManagerLinkedSheet } from "@/lib/sheet-sync/apply.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const maxDuration = 120;

function isAuthorized(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) return !isProductionRuntime();
  return req.headers.get("authorization") === `Bearer ${cronSecret}`;
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = createSupabaseServiceRoleClient();
  const linked = await listManagersWithSheetLinks(db);
  const results: Array<{ managerUserId: string; ok: boolean; error: string | null }> = [];

  for (const row of linked) {
    const { data: profile } = await db.from("profiles").select("email").eq("id", row.managerUserId).maybeSingle();
    try {
      const result = await syncManagerLinkedSheet(db, row.managerUserId, {
        managerEmail: typeof profile?.email === "string" ? profile.email : null,
      });
      results.push({ managerUserId: row.managerUserId, ok: result.ok, error: result.error });
    } catch (error) {
      results.push({
        managerUserId: row.managerUserId,
        ok: false,
        error: error instanceof Error ? error.message : "sync failed",
      });
    }
  }

  return NextResponse.json({ ok: true, managers: results.length, results });
}
