import { NextResponse } from "next/server";
import { mintOwnerDocumentUrl } from "@/lib/property-owner/documents.server";
import { requireOwnerRoute } from "@/lib/property-owner/route-auth.server";

export const runtime = "nodejs";

/** GET /api/owner/documents/[id]/signed-url — JSON, never a redirect (same contract as the manager route). */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const owner = await requireOwnerRoute();
  if (owner instanceof NextResponse) return owner;
  const { id } = await ctx.params;
  const download = new URL(req.url).searchParams.get("download") === "1";
  const minted = await mintOwnerDocumentUrl(owner.db, owner.grants, id, download);
  if (!minted) return NextResponse.json({ error: "Document not found." }, { status: 404 });
  return NextResponse.json(minted, { headers: { "Cache-Control": "private, no-store" } });
}
