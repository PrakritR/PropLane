import { NextResponse } from "next/server";
import { resolveAgentContext } from "@/lib/tools/context";
import { createMcpAuthorizationCode, getMcpOAuthClient, MCP_OAUTH_SCOPE, signMcpConnected, verifyMcpApproval } from "@/lib/mcp/oauth.server";
import { track } from "@/lib/analytics/posthog";

export const runtime = "nodejs";

function failure(): NextResponse { return NextResponse.json({ error: "invalid_request" }, { status: 400 }); }

export async function POST(req: Request) {
  const actor = await resolveAgentContext();
  if (!actor) return NextResponse.redirect(new URL("/auth/sign-in", req.url), 303);
  const form = await req.formData();
  const approval = verifyMcpApproval(String(form.get("approval") ?? ""));
  if (!approval || approval.userId !== actor.userId) return failure();
  const { clientId, redirectUri, codeChallenge: challenge, scope, state } = approval;
  const client = await getMcpOAuthClient(actor.db, clientId);
  if (!client || !client.redirectUris.includes(redirectUri) || challenge.length < 43 || !scope.split(/\s+/).every((item) => item === MCP_OAUTH_SCOPE)) return failure();
  // The manager's active workspace, read here because this is the only step
  // in the whole OAuth dance with a real browser session/cookie to resolve it
  // from (W001) — the token exchange and every later refresh just carry this
  // value forward. `id: ""` is the resolution-FAILURE sentinel
  // (`UNRESOLVED_AGENT_WORKSPACE_SCOPE`), never a real workspace, so it must
  // refuse rather than mint a connection with no workspace to narrow it.
  const workspaceId = actor.workspace?.id?.trim() || "";
  if (!workspaceId) return NextResponse.json({ error: "server_error" }, { status: 500 });
  const code = await createMcpAuthorizationCode(actor.db, {
    userId: actor.userId,
    clientId,
    redirectUri,
    codeChallenge: challenge,
    scopes: [MCP_OAUTH_SCOPE],
    workspaceId,
  });
  if (!code) return NextResponse.json({ error: "server_error" }, { status: 500 });
  track("mcp_connection_authorized", actor.userId, { client: clientId.slice(-8) });
  const destination = new URL(redirectUri);
  destination.searchParams.set("code", code);
  if (state) destination.searchParams.set("state", state);
  // Land on PropLane's own "connected" screen first; it carries the validated callback in a signed,
  // 2-minute token and continues to it. 303: the browser follows a form POST with a GET (307 would
  // re-POST to the client's callback). If the token cannot be signed, fall back to the callback itself.
  const token = signMcpConnected({
    destination: destination.toString(),
    clientName: client.clientName?.trim() || "your app",
    workspaceName: actor.workspace?.name?.trim() || "your workspace",
    userId: actor.userId,
  });
  if (!token) return NextResponse.redirect(destination, 303);
  // A relative Location: the browser resolves it against the host it actually used. `req.url` can
  // carry the dev server's bind address (0.0.0.0), where the session cookie does not exist.
  return new NextResponse(null, { status: 303, headers: { Location: `/mcp/connected?t=${encodeURIComponent(token)}` } });
}
