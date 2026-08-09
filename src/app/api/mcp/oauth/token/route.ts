import { NextResponse } from "next/server";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { exchangeMcpAuthorizationCode, refreshMcpAccessToken } from "@/lib/mcp/oauth.server";

export const runtime = "nodejs";

function oauthError(error: string, status = 400) { return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } }); }

export async function POST(req: Request) {
  if (!rateLimit(`mcp-oauth-token:${clientIpFrom(req)}`, 30, 60_000).ok) return oauthError("slow_down", 429);
  const form = await req.formData().catch(() => null);
  if (!form) return oauthError("invalid_request");
  const grantType = String(form.get("grant_type") ?? "");
  const clientId = String(form.get("client_id") ?? "");
  const db = createSupabaseServiceRoleClient();
  const issued = grantType === "authorization_code"
    ? await exchangeMcpAuthorizationCode(db, { code: String(form.get("code") ?? ""), clientId, redirectUri: String(form.get("redirect_uri") ?? ""), codeVerifier: String(form.get("code_verifier") ?? "") })
    : grantType === "refresh_token"
      ? await refreshMcpAccessToken(db, { refreshToken: String(form.get("refresh_token") ?? ""), clientId })
      : null;
  if (!issued) return oauthError(grantType === "authorization_code" || grantType === "refresh_token" ? "invalid_grant" : "unsupported_grant_type");
  return NextResponse.json({ access_token: issued.accessToken, refresh_token: issued.refreshToken, token_type: "Bearer", expires_in: 3600, scope: issued.scopes.join(" ") }, { headers: { "Cache-Control": "no-store" } });
}
