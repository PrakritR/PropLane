import { NextResponse } from "next/server";
import { assertOwnerPayloadRedacted } from "@/lib/property-owner/projection";
import { requireOwnerRoute } from "@/lib/property-owner/route-auth.server";
import { loadOwnerWorkspaces } from "@/lib/property-owner/workspaces.server";

export const runtime = "nodejs";

/** GET /api/owner/workspaces — the workspaces the signed-in Property owner belongs to (the rail's tiles). Never narrowed. */
export async function GET() {
  const ctx = await requireOwnerRoute();
  if (ctx instanceof NextResponse) return ctx;
  try {
    const workspaces = await loadOwnerWorkspaces(ctx.db, ctx.userId, ctx.grants);
    assertOwnerPayloadRedacted(workspaces);
    return NextResponse.json({ workspaces }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "Could not load your workspaces." }, { status: 500 });
  }
}
