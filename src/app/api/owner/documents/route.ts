import { NextResponse } from "next/server";
import { loadOwnerDocuments } from "@/lib/property-owner/documents.server";
import { requireOwnerRoute } from "@/lib/property-owner/route-auth.server";

export const runtime = "nodejs";

/** GET /api/owner/documents — files the manager shared with owners, on the owner's granted houses. */
export async function GET() {
  const ctx = await requireOwnerRoute();
  if (ctx instanceof NextResponse) return ctx;
  try {
    const documents = await loadOwnerDocuments(ctx.db, ctx.grants);
    return NextResponse.json({ documents }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "Could not load your documents." }, { status: 500 });
  }
}
