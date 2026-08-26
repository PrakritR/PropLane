import { NextResponse } from "next/server";
import { loadSharedLeasePayload } from "@/lib/portal-record-share-payload.server";
import { resolvePortalRecordShareToken } from "@/lib/portal-record-share-links.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/** Public lease view for an expiring share token (no auth). */
export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await ctx.params;
    const db = createSupabaseServiceRoleClient();
    const resolved = await resolvePortalRecordShareToken(db, decodeURIComponent(token));
    if (!resolved || resolved.link.recordKind !== "lease") {
      return NextResponse.json({ error: "Link expired or invalid." }, { status: 404 });
    }

    const payload = await loadSharedLeasePayload(db, resolved.link.recordId, resolved.managerUserId);
    if (!payload) return NextResponse.json({ error: "Lease not found." }, { status: 404 });

    return NextResponse.json(
      { ...payload, expiresAt: resolved.link.expiresAt },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
