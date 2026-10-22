import { NextResponse } from "next/server";
import type { MockProperty } from "@/data/types";
import { isPropertyActiveForLeads } from "@/lib/demo-property-pipeline";
import { geocodeListingAddress } from "@/lib/listing-geocode.server";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveTestWorkspaceRequestScope } from "@/lib/test-workspaces/index.server";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The map pin for ONE PUBLISHED listing, through the same ZIP-verified lookup the listing payload uses
 * (`listing-geocode.server`): a street hit is accepted only inside the listing's own ZIP, and the fallback is
 * that ZIP's centroid - never a city centre, and never the free-text `/api/geocode` match that put
 * "4709A 8th Ave, 98105" in Westlake.
 *
 * It exists for the second half of a cold load: the page's own lookup is bounded (`LISTING_GEOCODE_WAIT_MS`),
 * so a listing can ship without a pin while the lookup is still running. The client then asks here, which
 * reads the same 30-day cache that lookup is filling.
 *
 * It answers for exactly the homes the public catalog shows, by the same gates the single-listing public route
 * applies to this table: the request's test-workspace scope, `status = "live"`, and `isPropertyActiveForLeads`.
 * Anything else is a 404, so a draft, archived or sandbox home's coordinates never leave the server (its own
 * manager preview then draws the neutral fallback centre). The address is read from the STORED row, never from
 * the query: `propertyId` is the only input, so the cache this fills is keyed on the catalog's own addresses
 * rather than on anything a caller can invent, and only coordinates are ever returned.
 */
export async function GET(req: Request) {
  const propertyId = new URL(req.url).searchParams.get("propertyId")?.trim() ?? "";
  if (!UUID.test(propertyId)) {
    return NextResponse.json({ error: "A listing id is required." }, { status: 400 });
  }

  if (!(await rateLimit(`listing-geocode:${clientIpFrom(req)}`, 30, 60_000)).ok) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  }

  const notFound = () => NextResponse.json({ error: "Listing not found." }, { status: 404 });

  try {
    const db = createSupabaseServiceRoleClient();
    const scope = await resolveTestWorkspaceRequestScope();
    if (scope.kind === "denied") return notFound();
    let query = db
      .from("manager_property_records")
      .select("status, property_data, test_workspace_id")
      .eq("id", propertyId);
    query = scope.kind === "active"
      ? query.eq("test_workspace_id", scope.workspaceId)
      : query.is("test_workspace_id", null);
    const { data, error } = await query.maybeSingle();
    if (error) return NextResponse.json({ error: "Geocoding failed." }, { status: 502 });
    if (!data || data.status !== "live") return notFound();

    const stored = (data.property_data ?? null) as MockProperty | null;
    // `status` is the canonical publish state; an older row's JSON can predate `adminPublishLive`, which the
    // public catalog normalizes the same way before asking whether the home is active.
    const published = stored ? { ...stored, adminPublishLive: true as const } : null;
    if (!published || !isPropertyActiveForLeads(published)) return notFound();

    const coords = await geocodeListingAddress({
      address: published.address,
      zip: published.zip,
      city: published.listingSubmission?.city,
      state: published.state ?? published.listingSubmission?.state,
    });
    if (!coords) return NextResponse.json({ error: "Address could not be located." }, { status: 404 });
    return NextResponse.json(coords, {
      headers: { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800" },
    });
  } catch {
    return NextResponse.json({ error: "Geocoding failed." }, { status: 502 });
  }
}
