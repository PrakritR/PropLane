import { redirect } from "next/navigation";
import { Plug } from "lucide-react";
import { McpConnectHead, McpConnectNotice, McpConnectRows, McpConnectShell, McpTargetPicker } from "@/components/mcp/mcp-connect-ui";
import { McpSwitchAccountLink } from "@/components/mcp/mcp-switch-account-link";
import { Button } from "@/components/ui/button";
import { loadMcpConsent } from "@/lib/mcp/consent.server";
import { getMcpOAuthClient, MCP_OAUTH_SCOPE, signMcpApproval } from "@/lib/mcp/oauth.server";

export const metadata = { title: "Connect to PropLane", robots: { index: false, follow: false } };

const APPROVE_FORM_ID = "mcp-approve";

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
  const actor = await loadMcpConsent();
  if (!actor) redirect(`/auth/sign-in?next=${encodeURIComponent(authorizeUrl)}`);
  if (actor.options.length === 0) {
    return (
      <McpConnectNotice
        title="Nothing to connect yet"
        line="We couldn’t work out what this account may connect as. Open PropLane, pick the workspace you want, then start the connection again."
      />
    );
  }
  const client = await getMcpOAuthClient(actor.db, clientId);
  const valid = responseType === "code" && method === "S256" && challenge.length >= 43 && scope.split(/\s+/).every((item) => item === MCP_OAUTH_SCOPE) && Boolean(client?.redirectUris.includes(redirectUri));
  if (!valid || !client) {
    return <McpConnectNotice title="Couldn’t start this connection" line="The app sent an invalid or expired request. Return to it and try connecting again." />;
  }
  const approval = signMcpApproval({ userId: actor.userId, clientId, redirectUri, codeChallenge: challenge, scope, state });
  if (!approval) {
    return <McpConnectNotice title="Connections are unavailable" line="Authorization is temporarily down. Return to the app and try again shortly." />;
  }
  const residentOnly = actor.options.every((o) => o.kind === "resident");
  const mixed = !residentOnly && actor.options.some((o) => o.kind === "resident");
  const readLabel = residentOnly
    ? "Your home · Lease · Charges · Services · Messages"
    : mixed
      ? "Everything that role sees in PropLane"
      : "Properties · Residents · Bookings · Payments · Messages";
  const doLabel = residentOnly ? "Draft requests you approve in PropLane" : "Draft changes you approve in PropLane";
  const clientName = client.clientName?.trim() || "this app";
  return (
    <McpConnectShell>
      <McpConnectHead icon={Plug} title={`Connect ${clientName}`} />
      <McpConnectRows
        rows={[
          { label: "Signed in as", value: <>{actor.email} <McpSwitchAccountLink returnTo={authorizeUrl} /></>, attr: "mcp-consent-account" },
          { label: "Connect as", value: <McpTargetPicker options={actor.options} defaultValue={actor.defaultValue} formId={APPROVE_FORM_ID} />, attr: "mcp-consent-target" },
          { label: "App", value: clientName, attr: "mcp-consent-app" },
          { label: "Can read", value: readLabel, attr: "mcp-consent-read" },
          { label: "Can do", value: doLabel, attr: "mcp-consent-do" },
        ]}
      />
      <form id={APPROVE_FORM_ID} action="/api/mcp/oauth/approve" method="post" className="mt-6 grid grid-cols-2 gap-3">
        <input type="hidden" name="approval" value={approval} />
        <Button type="submit" className="order-2 w-full" data-attr="mcp-consent-allow">Allow</Button>
        <Button type="submit" variant="ghost" className="order-1 w-full" formAction="/api/mcp/oauth/deny" formNoValidate data-attr="mcp-consent-cancel">Cancel</Button>
      </form>
    </McpConnectShell>
  );
}
