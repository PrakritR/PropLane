import { NextResponse } from "next/server";

import { isProductionRuntime } from "@/lib/server-env";
import { listManagersWithSheetLinks, sheetLinkDueForSync } from "@/lib/manager-sheet-link";
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
  const now = new Date();

  for (const row of linked) {
    const due = row.bindings.filter((link) => sheetLinkDueForSync(link, now));
    if (due.length === 0) continue;
    const { data: profile } = await db.from("profiles").select("email").eq("id", row.managerUserId).maybeSingle();
    try {
      let ok = true;
      let error: string | null = null;
      for (const link of due) {
        const result = await syncManagerLinkedSheet(db, row.managerUserId, {
          managerEmail: typeof profile?.email === "string" ? profile.email : null,
          linkId: link.id,
        });
        if (!result.ok) {
          ok = false;
          error ??= result.error;
        }
      }
      results.push({ managerUserId: row.managerUserId, ok, error });
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
