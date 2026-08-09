import { NextResponse } from "next/server";
import { resolveRequestOrigin } from "@/lib/app-url";

export const runtime = "nodejs";

export function GET(req: Request) {
  const origin = resolveRequestOrigin(req);
  return NextResponse.json(
    { resource: `${origin}/api/mcp`, authorization_servers: [origin], scopes_supported: ["mcp:tools"] },
    { headers: { "Cache-Control": "public, max-age=3600" } },
  );
}
