import { NextResponse } from "next/server";
import { assertOwnerPayloadRedacted } from "@/lib/property-owner/projection";
import { requireOwnerRoute } from "@/lib/property-owner/route-auth.server";
import { loadOwnerSummary, OwnerScopeError } from "@/lib/property-owner/summary.server";

export const runtime = "nodejs";

/**
 * GET /api/owner/summary?propertyId=&period=YYYY-MM
 *
 * Totals per house and month for the houses the signed-in Property owner was
 * granted. `propertyId` can only narrow to a granted house (anything else is a
 * 404, indistinguishable from a house that does not exist); the owner and the
 * manager come from the membership, never from the query.
 */
export async function GET(req: Request) {
  const ctx = await requireOwnerRoute();
  if (ctx instanceof NextResponse) return ctx;
  const url = new URL(req.url);
  try {
    const summary = await loadOwnerSummary(ctx.db, ctx.grants, {
      period: url.searchParams.get("period"),
      propertyId: url.searchParams.get("propertyId"),
    });
    assertOwnerPayloadRedacted(summary);
    return NextResponse.json(summary, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof OwnerScopeError) return NextResponse.json({ error: error.message }, { status: 404 });
    return NextResponse.json({ error: "Could not load your properties." }, { status: 500 });
  }
}
