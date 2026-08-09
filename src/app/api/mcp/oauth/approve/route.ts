import { NextResponse } from "next/server";
import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import { createMcpAuthorizationCode, getMcpOAuthClient, MCP_OAUTH_SCOPE, verifyMcpApproval } from "@/lib/mcp/oauth.server";
import { track } from "@/lib/analytics/posthog";

export const runtime = "nodejs";

function failure(): NextResponse { return NextResponse.json({ error: "invalid_request" }, { status: 400 }); }

export async function POST(req: Request) {
  const actor = await requireManagerRouteUser();
  if (!actor) return NextResponse.redirect(new URL("/auth/sign-in", req.url));
  const form = await req.formData();
  const approval = verifyMcpApproval(String(form.get("approval") ?? ""));
  if (!approval || approval.userId !== actor.userId) return failure();
  const { clientId, redirectUri, codeChallenge: challenge, scope, state } = approval;
  const client = await getMcpOAuthClient(actor.db, clientId);
  if (!client || !client.redirectUris.includes(redirectUri) || challenge.length < 43 || !scope.split(/\s+/).every((item) => item === MCP_OAUTH_SCOPE)) return failure();
  const code = await createMcpAuthorizationCode(actor.db, { userId: actor.userId, clientId, redirectUri, codeChallenge: challenge, scopes: [MCP_OAUTH_SCOPE] });
  if (!code) return NextResponse.json({ error: "server_error" }, { status: 500 });
  track("mcp_connection_authorized", actor.userId, { client: clientId.slice(-8) });
  const destination = new URL(redirectUri);
  destination.searchParams.set("code", code);
  if (state) destination.searchParams.set("state", state);
  return NextResponse.redirect(destination);
}
