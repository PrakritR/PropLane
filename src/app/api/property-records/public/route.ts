import { NextResponse } from "next/server";
import { getPublicListings } from "@/lib/public-listings.server";
import { resolveTestWorkspaceRequestScope } from "@/lib/test-workspaces/index.server";

export const runtime = "nodejs";

/** Public catalog of admin-approved live manager listings (apply / browse). */
export async function GET() {
  try {
    const scope = await resolveTestWorkspaceRequestScope();
    if (scope.kind === "denied") return NextResponse.json(
      { error: "Not found.", testWorkspaceAccess: "denied" },
      { status: 404, headers: { "Cache-Control": "private, no-store" } },
    );
    const listings = await getPublicListings({ testWorkspaceId: scope.kind === "active" ? scope.workspaceId : null });
    // Public catalog, same for everyone: let the CDN serve repeats without
    // re-querying Supabase. s-maxage bounds staleness after a manager publishes.
    return NextResponse.json(
      { listings, ...(scope.kind === "active" ? { testWorkspaceId: scope.workspaceId } : {}) },
      { headers: scope.kind === "active"
        ? { "Cache-Control": "private, no-store" }
        : { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=600" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load public listings." },
      { status: 500 },
    );
  }
}
