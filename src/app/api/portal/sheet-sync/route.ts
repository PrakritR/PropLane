import { NextResponse } from "next/server";

import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import { syncManagerLinkedSheet } from "@/lib/sheet-sync/apply.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  const actor = await requireManagerRouteUser();
  if (!actor) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { linkId?: unknown; propertyId?: unknown } | null;
  const db = createSupabaseServiceRoleClient();
  const { data: profile } = await db.from("profiles").select("email").eq("id", actor.userId).maybeSingle();
  try {
    const result = await syncManagerLinkedSheet(actor.db, actor.userId, {
      managerEmail: typeof profile?.email === "string" ? profile.email : null,
      linkId: typeof body?.linkId === "string" ? body.linkId.trim() : null,
      propertyId: typeof body?.propertyId === "string" ? body.propertyId.trim() : null,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error ?? "Could not update from the sheet.", summary: result.summary }, { status: 400 });
    }
    return NextResponse.json({ ok: true, summary: result.summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not update from the sheet.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
