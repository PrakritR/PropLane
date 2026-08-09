import { NextResponse } from "next/server";

import { resolveAgentContext } from "@/lib/tools/context";
import { listMcpOAuthConnections } from "@/lib/mcp/oauth.server";

export const runtime = "nodejs";

export async function GET() {
  const ctx = await resolveAgentContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  return NextResponse.json({ connections: await listMcpOAuthConnections(ctx.db, ctx.userId) });
}
