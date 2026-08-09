import { NextResponse } from "next/server";

import { resolveAgentContext } from "@/lib/tools/context";
import { revokeMcpOAuthConnection } from "@/lib/mcp/oauth.server";
import { track } from "@/lib/analytics/posthog";

export const runtime = "nodejs";

export async function DELETE(_req: Request, { params }: { params: Promise<{ clientId: string }> }) {
  const ctx = await resolveAgentContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { clientId } = await params;
  if (!clientId) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const revoked = await revokeMcpOAuthConnection(ctx.db, ctx.userId, clientId);
  if (!revoked) return NextResponse.json({ error: "Connection not found." }, { status: 404 });
  track("mcp_connection_revoked", ctx.userId, { client: clientId.slice(-8) });
  return NextResponse.json({ ok: true });
}
