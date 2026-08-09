import { NextResponse } from "next/server";
import { resolveRequestOrigin } from "@/lib/app-url";

export const runtime = "nodejs";

export function GET(req: Request) {
  const origin = resolveRequestOrigin(req);
  return NextResponse.json(
    {
      issuer: origin,
      authorization_endpoint: `${origin}/mcp/authorize`,
      token_endpoint: `${origin}/api/mcp/oauth/token`,
      registration_endpoint: `${origin}/api/mcp/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["mcp:tools"],
    },
    { headers: { "Cache-Control": "public, max-age=3600" } },
  );
}
