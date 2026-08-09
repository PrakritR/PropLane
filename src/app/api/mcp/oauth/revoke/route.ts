import { NextResponse } from "next/server";

import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { revokeMcpOAuthToken } from "@/lib/mcp/oauth.server";

export const runtime = "nodejs";

/** RFC 7009: succeed even when a token is already invalid, never leak token state. */
export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  const token = String(form?.get("token") ?? "");
  const clientId = String(form?.get("client_id") ?? "");
  if (token && clientId) await revokeMcpOAuthToken(createSupabaseServiceRoleClient(), { token, clientId });
  return new NextResponse(null, { status: 200, headers: { "Cache-Control": "no-store" } });
}
