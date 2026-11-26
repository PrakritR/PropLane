import { NextResponse } from "next/server";
import { loadMcpConsent, resolveMcpTarget } from "@/lib/mcp/consent.server";
import { createMcpAuthorizationCode, getMcpOAuthClient, MCP_OAUTH_SCOPE, signMcpConnected, verifyMcpApproval } from "@/lib/mcp/oauth.server";
import { track } from "@/lib/analytics/posthog";

export const runtime = "nodejs";

function failure(): NextResponse { return NextResponse.json({ error: "invalid_request" }, { status: 400 }); }

export async function POST(req: Request) {
  const session = await loadMcpConsent();
  if (!session) return NextResponse.redirect(new URL("/auth/sign-in", req.url), 303);
  const form = await req.formData();
  const approval = verifyMcpApproval(String(form.get("approval") ?? ""));
  if (!approval || approval.userId !== session.userId) return failure();
  const { clientId, redirectUri, codeChallenge: challenge, scope, state } = approval;
  const client = await getMcpOAuthClient(session.db, clientId);
  if (!client || !client.redirectUris.includes(redirectUri) || challenge.length < 43 || !scope.split(/\s+/).every((item) => item === MCP_OAUTH_SCOPE)) return failure();
  // What this connection IS, re-derived here from membership: the posted choice is a name, never a grant
  // (W001). Nothing posted means the workspace the person has open. A choice that does not resolve right now
  // (a removed seat, a lapsed resident role) refuses rather than minting a connection with no scope.
  const posted = String(form.get("target") ?? "").trim() || session.defaultValue;
  const target = await resolveMcpTarget(session.db, session.userId, posted);
  if (!target) return NextResponse.json({ error: "invalid_target" }, { status: 400 });
  const code = await createMcpAuthorizationCode(session.db, {
    userId: session.userId,
    clientId,
    redirectUri,
    codeChallenge: challenge,
    scopes: [MCP_OAUTH_SCOPE],
    workspaceId: target.portal === "manager" ? target.workspaceId : null,
    portal: target.portal,
  });
  if (!code) return NextResponse.json({ error: "server_error" }, { status: 500 });
  track("mcp_connection_authorized", session.userId, { client: clientId.slice(-8), portal: target.portal });
  const destination = new URL(redirectUri);
  destination.searchParams.set("code", code);
  if (state) destination.searchParams.set("state", state);
  // Land on PropLane's own "connected" screen first; it carries the validated callback in a signed,
  // 2-minute token and continues to it. 303: the browser follows a form POST with a GET (307 would
  // re-POST to the client's callback). If the token cannot be signed, fall back to the callback itself.
  const token = signMcpConnected({
    destination: destination.toString(),
    clientName: client.clientName?.trim() || "your app",
    workspaceName: target.portal === "manager" ? target.workspaceName : "Your residency",
    userId: session.userId,
  });
  if (!token) return NextResponse.redirect(destination, 303);
  // A relative Location: the browser resolves it against the host it actually used. `req.url` can
  // carry the dev server's bind address (0.0.0.0), where the session cookie does not exist.
  // The parameter is named `token` because the signed value carries the one-time
  // authorization code: `sanitizeAnalyticsProperties` redacts a `token=` query, so
  // PropLane's own $pageview can never ship it to an analytics processor.
  return new NextResponse(null, { status: 303, headers: { Location: `/mcp/connected?token=${encodeURIComponent(token)}` } });
}
