import { NextResponse } from "next/server";

import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import { managerHasCalendarAccessForProperty } from "@/lib/auth/manager-lease-scope";
import { occupancySnapshotForManager } from "@/lib/occupancy/snapshot.server";

export const runtime = "nodejs";

function dayParam(raw: string | null): string | null {
  const value = String(raw ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

/**
 * The exact days a caller needs, instead of every day between `from` and `to`. A dashboard that
 * draws nine figures used to pay for 250 day-cells per house; a day outside [from, to] is ignored.
 */
const MAX_REQUESTED_DAYS = 40;

function daysParam(raw: string | null, from: string, to: string): string[] | null {
  if (raw === null) return null;
  const days = [
    ...new Set(
      raw
        .split(",")
        .map((value) => value.trim())
        .filter((value) => dayParam(value) && value >= from && value <= to),
    ),
  ].sort();
  return days.slice(0, MAX_REQUESTED_DAYS);
}

export async function GET(req: Request) {
  try {
    const actor = await requireManagerRouteUser({ fast: true });
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
    const days = daysParam(url.searchParams.get("days"), from, to);
    if (days !== null && days.length === 0) {
      return NextResponse.json({ error: "days must be YYYY-MM-DD keys inside from..to." }, { status: 400 });
    }

    const allowed: string[] = [];
    for (const propertyId of propertyIds) {
      if (await managerHasCalendarAccessForProperty(actor.db, actor.userId, propertyId)) allowed.push(propertyId);
    }
    const snapshot = await occupancySnapshotForManager(actor.db, actor.userId, {
      propertyIds: allowed,
      from,
      to,
      ...(days ? { days } : {}),
      browserOrigin: url.origin,
    });
    return NextResponse.json(snapshot, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed." }, { status: 500 });
  }
}
