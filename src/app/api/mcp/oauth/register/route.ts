import { NextResponse } from "next/server";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { registerMcpOAuthClient } from "@/lib/mcp/oauth.server";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!rateLimit(`mcp-oauth-register:${clientIpFrom(req)}`, 10, 60_000).ok) return NextResponse.json({ error: "slow_down" }, { status: 429 });
  let body: { redirect_uris?: unknown; client_name?: unknown; token_endpoint_auth_method?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid_client_metadata" }, { status: 400 }); }
  if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none") return NextResponse.json({ error: "invalid_client_metadata" }, { status: 400 });
  const result = await registerMcpOAuthClient(createSupabaseServiceRoleClient(), {
    clientName: typeof body.client_name === "string" ? body.client_name : undefined,
    redirectUris: Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [],
  });
  if (!result) return NextResponse.json({ error: "invalid_redirect_uri" }, { status: 400 });
  return NextResponse.json({ client_id: result.clientId, client_name: result.clientName, redirect_uris: result.redirectUris, token_endpoint_auth_method: "none" }, { status: 201 });
}
