import { NextResponse } from "next/server";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { submitShortStayRequest, type ShortStayRequestBody } from "@/lib/short-stay-request.server";

export const runtime = "nodejs";

/** Public, unauthenticated: a guest's short-stay "Request to book". See `short-stay-request.server.ts`. */
export async function POST(req: Request) {
  try {
    if (!(await rateLimit(`short-stay-request:${clientIpFrom(req)}`, 10, 60_000)).ok) {
      return NextResponse.json({ error: "Too many requests. Please wait a minute and try again." }, { status: 429 });
    }
    let body: ShortStayRequestBody;
    try {
      body = (await req.json()) as ShortStayRequestBody;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid body." }, { status: 400 });
    const result = await submitShortStayRequest(createSupabaseServiceRoleClient(), body);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status, headers: { "Cache-Control": "private, no-store" } });
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "Could not send your request." }, { status: 500 });
  }
}
