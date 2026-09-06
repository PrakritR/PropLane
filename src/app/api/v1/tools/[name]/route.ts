/**
 * Call one tool over plain HTTP. The request body IS the tool's input object.
 *
 * Write tools behave exactly as they do over MCP: they stage a pending action
 * and return `202` with an actionId. Nothing is written until a second call to
 * `POST /api/v1/tools/confirm_action`.
 */
import { NextResponse } from "next/server";

import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { resolveApiKeyContext } from "@/lib/mcp/context.server";
import { callTool } from "@/lib/mcp/gateway";

export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ name: string }> }) {
  if (!(await rateLimit(`api-v1-auth:${clientIpFrom(req)}`, 60, 60_000)).ok) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  }
  const auth = await resolveApiKeyContext(req, "api");
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.error },
      { status: auth.status, headers: { "WWW-Authenticate": 'Bearer realm="PropLane API"' } },
    );
  }
  if (!(await rateLimit(`api-v1:${auth.keyId}`, 120, 60_000)).ok) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  }

  const { name } = await ctx.params;
  let input: unknown = {};
  try {
    const text = await req.text();
    if (text.trim()) input = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Request body is not valid JSON." }, { status: 400 });
  }

  const result = await callTool(auth.ctx, auth.allowedTools, auth.scopes, name, input, "rest", auth.keyId);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  // A staged write is accepted-but-not-done; say so in the status code too.
  const staged = (result.data as { status?: unknown } | null)?.status === "awaiting_confirmation";
  return NextResponse.json(result.data, { status: staged ? 202 : 200 });
}
