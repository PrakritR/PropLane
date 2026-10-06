import { NextResponse } from "next/server";
import { clientIpFrom } from "@/lib/rate-limit";
import { allowServiceShareResolve, hashServiceShareToken } from "@/lib/service-share-links.server";
import { resolvePublicServiceByToken } from "@/lib/service-work-board.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

const HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" } as const;

/**
 * The public view of a texted service (vendor-work-share-1006): the `publicServiceProjection`
 * allowlist and nothing else - no address, unit, resident, cost or id. No account needed to read it;
 * an unknown, expired and revoked token all answer the same 404 so a link cannot be probed.
 */
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const allowed = await allowServiceShareResolve({ ip: clientIpFrom(req), tokenHash: hashServiceShareToken(token ?? "") });
  if (!allowed) return NextResponse.json({ error: "Too many requests." }, { status: 429, headers: HEADERS });
  try {
    const resolved = await resolvePublicServiceByToken(createSupabaseServiceRoleClient(), token ?? "");
    if (!resolved) {
      return NextResponse.json({ error: "This link has expired or is no longer valid." }, { status: 404, headers: HEADERS });
    }
    return NextResponse.json({ service: resolved.service, state: resolved.state }, { headers: HEADERS });
  } catch {
    return NextResponse.json({ error: "Could not load this job." }, { status: 500, headers: HEADERS });
  }
}
