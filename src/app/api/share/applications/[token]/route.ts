import { NextResponse } from "next/server";
import { loadSharedApplicationPayload } from "@/lib/portal-record-share-payload.server";
import { resolvePortalRecordShareToken } from "@/lib/portal-record-share-links.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/** Public application view for an expiring share token (no auth). */
export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await ctx.params;
    const db = createSupabaseServiceRoleClient();
    const resolved = await resolvePortalRecordShareToken(db, decodeURIComponent(token));
    if (!resolved || resolved.link.recordKind !== "application") {
      return NextResponse.json({ error: "Link expired or invalid." }, { status: 404 });
    }

    const payload = await loadSharedApplicationPayload(db, resolved.link.recordId, {
      recordOwnerUserId: resolved.recordOwnerUserId,
    });
    if (!payload) return NextResponse.json({ error: "Application not found." }, { status: 404 });

    return NextResponse.json(
      { ...payload, expiresAt: resolved.link.expiresAt },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ error: "Could not load shared application." }, { status: 500 });
  }
}
