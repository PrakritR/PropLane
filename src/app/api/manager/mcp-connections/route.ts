import { NextResponse } from "next/server";

import { resolveAgentContext } from "@/lib/tools/context";
import { resolveResidentAgentContext } from "@/lib/tools/resident-context";
import { listMcpOAuthConnections } from "@/lib/mcp/oauth.server";

export const runtime = "nodejs";

export async function GET() {
  // A manager, or a resident who connected Claude "As resident": either can see and disconnect their own.
  const ctx = (await resolveAgentContext()) ?? (await resolveResidentAgentContext());
  if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  return NextResponse.json({ connections: await listMcpOAuthConnections(ctx.db, ctx.userId) });
}
