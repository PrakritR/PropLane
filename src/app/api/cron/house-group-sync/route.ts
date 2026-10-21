import { NextResponse } from "next/server";
import { createConversationsGateway } from "@/lib/house-groups/conversations-gateway.server";
import { closeStaleRetiredGroups, syncAllHouseGroups } from "@/lib/house-groups/manager.server";
import { syncAllHouseChats, syncWorkspaceHouseChats } from "@/lib/house-chat/sync.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Daily: make every enabled house's SMS group match its residents and close groups retired over 30 days ago,
 * then (independent of the SMS flags) keep every in-app house chat's roster current and move the one-on-one
 * conversations of residents who have moved out to Archived.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  try {
    const db = createSupabaseServiceRoleClient();
    // `?houseChatsOnly=<workspaceId>`: run the in-app step for ONE workspace and nothing else (ops and proofs).
    const only = new URL(req.url).searchParams.get("houseChatsOnly")?.trim();
    if (only) return NextResponse.json({ ok: true, houseChats: await syncWorkspaceHouseChats(db, only) });
    const summary = await syncAllHouseGroups(db);
    const closed = await closeStaleRetiredGroups(db, createConversationsGateway());
    // The in-app step never depends on the SMS group step: a failure in one must not skip the other.
    const houseChats = await syncAllHouseChats(db).catch(() => null);
    return NextResponse.json({ ok: true, ...summary, closed, houseChats });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "House group sync failed." }, { status: 503 });
  }
}
