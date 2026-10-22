import { NextResponse } from "next/server";

import { syncChannelCalendarConnection } from "@/lib/channel-calendar/sync.server";
import { managerCanWriteCalendarForProperty } from "@/lib/auth/manager-lease-scope";
import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const ctx = await requireManagerRouteUser();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const body = (await req.json().catch(() => ({}))) as { propertyIds?: string[] };
    const requested = (body.propertyIds ?? []).map((id) => String(id).trim()).filter(Boolean);

    // Scoped by HOUSE, not by who typed the link: a co-manager with Calendar at edit and service-mode staff
    // sync the owner's connections, which `manager_user_id` alone left out (Sync all reported 0 for them).
    // Every row is still gated below by the same write check the single-connection sync applies.
    let query = ctx.db.from("external_calendar_connections").select("id, property_id, import_url");
    query = requested.length > 0 ? query.in("property_id", requested) : query.eq("manager_user_id", ctx.userId);
    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const syncable: string[] = [];
    for (const row of data ?? []) {
      if (!String(row.import_url ?? "").trim()) continue;
      if (!(await managerCanWriteCalendarForProperty(ctx.db, ctx.userId, String(row.property_id)))) continue;
      syncable.push(String(row.id));
    }

    let synced = 0;
    let failed = 0;
    for (const connectionId of syncable) {
      try {
        await syncChannelCalendarConnection(ctx.db, connectionId);
        synced += 1;
      } catch {
        failed += 1;
      }
    }

    return NextResponse.json({
      synced,
      failed,
      residents: synced,
      snapshotVersion: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Sync failed." }, { status: 500 });
  }
}
