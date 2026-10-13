import { redirect } from "next/navigation";
import { Plug } from "lucide-react";
import { McpConnectHead, McpConnectNotice, McpConnectRows, McpConnectShell } from "@/components/mcp/mcp-connect-ui";
import { McpSwitchAccountLink } from "@/components/mcp/mcp-switch-account-link";
import { Button } from "@/components/ui/button";
import { resolveAgentContext } from "@/lib/tools/context";
import { getMcpOAuthClient, MCP_OAUTH_SCOPE, signMcpApproval } from "@/lib/mcp/oauth.server";

export const metadata = { title: "Connect to PropLane", robots: { index: false, follow: false } };

type Search = Record<string, string | string[] | undefined>;
function value(search: Search, key: string): string { const raw = search[key]; return typeof raw === "string" ? raw : ""; }

export default async function McpAuthorizePage({ searchParams }: { searchParams: Promise<Search> }) {
  const search = await searchParams;
  const clientId = value(search, "client_id");
  const redirectUri = value(search, "redirect_uri");
  const challenge = value(search, "code_challenge");
  const method = value(search, "code_challenge_method");
  const responseType = value(search, "response_type");
  const scope = value(search, "scope") || MCP_OAUTH_SCOPE;
  const state = value(search, "state");
  const authorizeParams = new URLSearchParams();
  for (const [key, raw] of Object.entries(search)) if (typeof raw === "string") authorizeParams.set(key, raw);
  const authorizeUrl = `/mcp/authorize?${authorizeParams.toString()}`;
  const actor = await resolveAgentContext();
  if (!actor) redirect(`/auth/sign-in?next=${encodeURIComponent(authorizeUrl)}`);
  const client = await getMcpOAuthClient(actor.db, clientId);
  const valid = responseType === "code" && method === "S256" && challenge.length >= 43 && scope.split(/\s+/).every((item) => item === MCP_OAUTH_SCOPE) && Boolean(client?.redirectUris.includes(redirectUri));
  if (!valid || !client) {
    return <McpConnectNotice title="Couldn’t start this connection" line="The app sent an invalid or expired request. Return to it and try connecting again." />;
  }
  const workspaceName = actor.workspace?.id?.trim() ? actor.workspace.name?.trim() || "Your workspace" : "";
  if (!workspaceName) {
    return <McpConnectNotice title="Pick a workspace first" line="Open PropLane, choose a workspace, then connect again." />;
  }
  const approval = signMcpApproval({ userId: actor.userId, clientId, redirectUri, codeChallenge: challenge, scope, state });
  if (!approval) {
    return <McpConnectNotice title="Connections are unavailable" line="Authorization is temporarily down. Return to the app and try again shortly." />;
  }
  const clientName = client.clientName?.trim() || "this app";
  return (
    <McpConnectShell>
      <McpConnectHead icon={Plug} title={`Connect ${clientName}`} />
      <McpConnectRows
        rows={[
          { label: "Signed in as", value: <>{actor.email} <McpSwitchAccountLink returnTo={authorizeUrl} /></>, attr: "mcp-consent-account" },
          { label: "Workspace", value: workspaceName, attr: "mcp-consent-workspace" },
          { label: "App", value: clientName, attr: "mcp-consent-app" },
          { label: "Can read", value: "Properties · Residents · Bookings · Payments · Messages", attr: "mcp-consent-read" },
          { label: "Can do", value: "Draft changes you approve in PropLane", attr: "mcp-consent-do" },
        ]}
      />
      <form action="/api/mcp/oauth/approve" method="post" className="mt-6 grid grid-cols-2 gap-3">
        <input type="hidden" name="approval" value={approval} />
        <Button type="submit" className="order-2 w-full" data-attr="mcp-consent-allow">Allow</Button>
        <Button type="submit" variant="ghost" className="order-1 w-full" formAction="/api/mcp/oauth/deny" formNoValidate data-attr="mcp-consent-cancel">Cancel</Button>
      </form>
    </McpConnectShell>
  );
}
