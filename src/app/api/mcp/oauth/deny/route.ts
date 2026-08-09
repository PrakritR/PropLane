import { NextResponse } from "next/server";

import { resolveAgentContext } from "@/lib/tools/context";
import { getMcpOAuthClient, verifyMcpApproval } from "@/lib/mcp/oauth.server";

export const runtime = "nodejs";

/** Return an OAuth-standard denial to the registered client, preserving state. */
export async function POST(req: Request) {
  const actor = await resolveAgentContext();
  if (!actor) return NextResponse.redirect(new URL("/auth/sign-in", req.url));

  const form = await req.formData();
  const approval = verifyMcpApproval(String(form.get("approval") ?? ""));
  if (!approval || approval.userId !== actor.userId) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const client = await getMcpOAuthClient(actor.db, approval.clientId);
  if (!client?.redirectUris.includes(approval.redirectUri)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const destination = new URL(approval.redirectUri);
  destination.searchParams.set("error", "access_denied");
  if (approval.state) destination.searchParams.set("state", approval.state);
  return NextResponse.redirect(destination);
}
