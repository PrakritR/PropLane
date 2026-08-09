/**
 * Plain-HTTP tool catalog — the escape hatch for harnesses that do not speak
 * MCP. Same key, same scopes, same gateway as `/api/mcp`; only the envelope
 * differs.
 */
import { NextResponse } from "next/server";

import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { resolveApiKeyContext } from "@/lib/mcp/context.server";
import { listTools } from "@/lib/mcp/gateway";

export const runtime = "nodejs";

export async function GET(req: Request) {
  if (!rateLimit(`api-v1-auth:${clientIpFrom(req)}`, 60, 60_000).ok) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  }
  const auth = await resolveApiKeyContext(req, "api");
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.error },
      { status: auth.status, headers: { "WWW-Authenticate": 'Bearer realm="PropLane API"' } },
    );
  }
  if (!rateLimit(`api-v1:${auth.keyId}`, 120, 60_000).ok) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  }
  return NextResponse.json({ tools: listTools(auth.allowedTools, auth.scopes) });
}
