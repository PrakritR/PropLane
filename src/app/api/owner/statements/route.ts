import { NextResponse } from "next/server";
import { assertOwnerPayloadRedacted } from "@/lib/property-owner/projection";
import { requireOwnerRoute } from "@/lib/property-owner/route-auth.server";
import { loadOwnerStatements } from "@/lib/property-owner/summary.server";

export const runtime = "nodejs";

/** GET /api/owner/statements — one row per month over the houses the owner may see statements for. */
export async function GET() {
  const ctx = await requireOwnerRoute();
  if (ctx instanceof NextResponse) return ctx;
  try {
    const statements = await loadOwnerStatements(ctx.db, ctx.grants);
    assertOwnerPayloadRedacted(statements);
    return NextResponse.json(statements, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "Could not load your statements." }, { status: 500 });
  }
}
