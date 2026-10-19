import { NextResponse } from "next/server";
import { loadOwnerOverviewExtras } from "@/lib/property-owner/overview.server";
import { assertOwnerPayloadRedacted } from "@/lib/property-owner/projection";
import { requireOwnerRoute } from "@/lib/property-owner/route-auth.server";

export const runtime = "nodejs";

/**
 * GET /api/owner/overview[?workspace=] — what the Overview adds to /api/owner/summary: PropLane-held fee / net / available for
 * a managed workspace, what needs the owner, and what is coming up. Scoped by the owner's membership and, for the money, by
 * their own user id as owner of record.
 */
export async function GET(req: Request) {
  const ctx = await requireOwnerRoute(req);
  if (ctx instanceof NextResponse) return ctx;
  try {
    const extras = await loadOwnerOverviewExtras(ctx.db, ctx.userId, ctx.grants);
    assertOwnerPayloadRedacted(extras);
    return NextResponse.json(extras, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "Could not load your overview." }, { status: 500 });
  }
}
