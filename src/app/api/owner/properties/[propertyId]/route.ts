import { NextResponse } from "next/server";
import { assertOwnerPayloadRedacted } from "@/lib/property-owner/projection";
import { loadOwnerPropertyDetail } from "@/lib/property-owner/property-detail.server";
import { requireOwnerRoute } from "@/lib/property-owner/route-auth.server";
import { OwnerScopeError } from "@/lib/property-owner/summary.server";

export const runtime = "nodejs";

/** GET /api/owner/properties/<id> — photos and services history of one granted house; anything else is a 404. */
export async function GET(req: Request, context: { params: Promise<{ propertyId: string }> }) {
  const ctx = await requireOwnerRoute(req);
  if (ctx instanceof NextResponse) return ctx;
  const { propertyId } = await context.params;
  try {
    const detail = await loadOwnerPropertyDetail(ctx.db, ctx.grants, decodeURIComponent(propertyId));
    assertOwnerPayloadRedacted(detail);
    return NextResponse.json(detail, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof OwnerScopeError) return NextResponse.json({ error: error.message }, { status: 404 });
    return NextResponse.json({ error: "Could not load this property." }, { status: 500 });
  }
}
