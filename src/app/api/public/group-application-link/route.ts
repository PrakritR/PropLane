import { NextResponse } from "next/server";
import { loadGroupLeaderLinkPreview } from "@/lib/rental-application/group-leader-link.server";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/** Read-only check that an organizer application id can link a joining roommate. */
export async function GET(req: Request) {
  try {
    if (!(await rateLimit(`group-application-link:${clientIpFrom(req)}`, 60, 60_000)).ok) {
      return NextResponse.json({ error: "Too many requests. Please slow down." }, { status: 429 });
    }

    const url = new URL(req.url);
    const leaderAppId = url.searchParams.get("leaderAppId")?.trim() ?? "";
    if (!leaderAppId) {
      return NextResponse.json(
        { ok: false, code: "invalid_id", message: "leaderAppId is required." },
        { status: 400 },
      );
    }

    const db = createSupabaseServiceRoleClient();
    const preview = await loadGroupLeaderLinkPreview(db, leaderAppId);
    return NextResponse.json(preview, { status: preview.ok ? 200 : 404 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not verify that group link.";
    return NextResponse.json({ ok: false, code: "not_found", message }, { status: 500 });
  }
}
