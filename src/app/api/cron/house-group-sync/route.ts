import { NextResponse } from "next/server";
import { createConversationsGateway } from "@/lib/house-groups/conversations-gateway.server";
import { closeStaleRetiredGroups, syncAllHouseGroups } from "@/lib/house-groups/manager.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Daily: make every enabled house's group match its residents, and close groups retired over 30 days ago. */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  try {
    const db = createSupabaseServiceRoleClient();
    const summary = await syncAllHouseGroups(db);
    const closed = await closeStaleRetiredGroups(db, createConversationsGateway());
    return NextResponse.json({ ok: true, ...summary, closed });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "House group sync failed." }, { status: 503 });
  }
}
