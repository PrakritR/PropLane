import { NextResponse } from "next/server";
import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import { loadManagerDoorCount, type ListingDoorBreakdown } from "@/lib/billing/door-count.server";

export const runtime = "nodejs";

export type ManagerDoorCountPayload = {
  totalDoors: number;
  breakdown: ListingDoorBreakdown[];
};

/**
 * Settings → Billing & plan's own door count, read LIVE (never the frozen
 * `manager_door_count_snapshots` row a bill was issued against — see
 * `door-count-snapshot.server.ts`). This route exists so a manager can see
 * what a listing edit does to their bill before the next billing period takes
 * a snapshot; it is display-only and never used to price an actual charge.
 */
export async function GET() {
  const auth = await requireManagerRouteUser();
  if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 403 });

  const counted = await loadManagerDoorCount(auth.db, auth.userId);
  if (!counted.ok) {
    return NextResponse.json({ error: counted.error }, { status: 503 });
  }

  const payload: ManagerDoorCountPayload = { totalDoors: counted.totalDoors, breakdown: counted.breakdown };
  return NextResponse.json(payload, { headers: { "Cache-Control": "private, no-store" } });
}
