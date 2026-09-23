import { NextResponse } from "next/server";

import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import { managerHasCalendarAccessForProperty } from "@/lib/auth/manager-lease-scope";
import { occupancySnapshotForManager } from "@/lib/occupancy/snapshot.server";

export const runtime = "nodejs";

function dayParam(raw: string | null): string | null {
  const value = String(raw ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

export async function GET(req: Request) {
  try {
    const actor = await requireManagerRouteUser();
    if (!actor) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const url = new URL(req.url);
    const propertyIds = (url.searchParams.get("propertyIds") ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    const from = dayParam(url.searchParams.get("from"));
    const to = dayParam(url.searchParams.get("to"));
    if (propertyIds.length === 0 || !from || !to) {
      return NextResponse.json({ error: "propertyIds, from, and to are required." }, { status: 400 });
    }

    const allowed: string[] = [];
    for (const propertyId of propertyIds) {
      if (await managerHasCalendarAccessForProperty(actor.db, actor.userId, propertyId)) allowed.push(propertyId);
    }
    const snapshot = await occupancySnapshotForManager(actor.db, actor.userId, {
      propertyIds: allowed,
      from,
      to,
      browserOrigin: url.origin,
    });
    return NextResponse.json(snapshot, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed." }, { status: 500 });
  }
}
