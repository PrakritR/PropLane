import { NextResponse } from "next/server";
import { assertOwnerPayloadRedacted } from "@/lib/property-owner/projection";
import { requireOwnerRoute } from "@/lib/property-owner/route-auth.server";
import { loadOwnerStatements, OwnerScopeError } from "@/lib/property-owner/summary.server";

export const runtime = "nodejs";

/** GET /api/owner/statements — one row per month over the houses the owner may see statements for. */
export async function GET(req: Request) {
  const ctx = await requireOwnerRoute();
  if (ctx instanceof NextResponse) return ctx;
  try {
    const statements = await loadOwnerStatements(ctx.db, ctx.grants, {
      propertyId: new URL(req.url).searchParams.get("propertyId"),
    });
    assertOwnerPayloadRedacted(statements);
    return NextResponse.json(statements, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof OwnerScopeError) return NextResponse.json({ error: error.message }, { status: 404 });
    return NextResponse.json({ error: "Could not load your statements." }, { status: 500 });
  }
}
