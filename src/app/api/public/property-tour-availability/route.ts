import { NextResponse } from "next/server";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import {
  listOpenTourSlots,
  TOUR_AVAILABILITY_RATE_LIMIT,
  TOUR_AVAILABILITY_RATE_LIMIT_WINDOW_MS,
} from "@/lib/tour-availability.server";

export const runtime = "nodejs";

/**
 * Public tour availability grid for one property.
 *
 * The computation — `offered = published (or the 9-5 default) MINUS
 * calendar-busy MINUS already-booked` — lives in `listOpenTourSlots` so the
 * assistant's tour tools answer "what is open" from the exact same function.
 * Nothing may offer a slot this grid would not.
 *
 * What stays here is what only an HTTP request has: the per-IP cap, and the
 * cache header.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const propertyId = searchParams.get("propertyId")?.trim();
  if (!propertyId) return NextResponse.json({ error: "propertyId required" }, { status: 400 });

  if (
    !(await rateLimit(
      `property-tour-availability:${clientIpFrom(req)}`,
      TOUR_AVAILABILITY_RATE_LIMIT,
      TOUR_AVAILABILITY_RATE_LIMIT_WINDOW_MS,
    )).ok
  ) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down." },
      { status: 429, headers: { "Cache-Control": "no-store" } },
    );
  }

  const result = await listOpenTourSlots(createSupabaseServiceRoleClient(), {
    propertyId,
    buildingName: searchParams.get("buildingName"),
    address: searchParams.get("address"),
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 });

  // NOT edge-cached, deliberately, against this repo's usual prefer-caching
  // rule. `s-maxage=300, stale-while-revalidate=600` meant a slot booked
  // seconds ago stayed on offer for up to fifteen minutes, and a manager who
  // published a window watched the page ignore it for five — both reported.
  // A double-booked tour costs more than the egress. Repeat load is absorbed
  // instead by the in-process Google busy cache inside listOpenTourSlots.
  return NextResponse.json({ slotHosts: result.slotHosts }, { headers: { "Cache-Control": "no-store" } });
}
