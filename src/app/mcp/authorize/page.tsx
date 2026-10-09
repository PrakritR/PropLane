import { redirect } from "next/navigation";
import { Building2, Eye, ShieldCheck, Unplug } from "lucide-react";
import { McpConnectHeader, McpConnectNotice, McpConnectShell } from "@/components/mcp/mcp-connect-ui";
import { McpSwitchAccountLink } from "@/components/mcp/mcp-switch-account-link";
import { Button } from "@/components/ui/button";
import { resolveAgentContext } from "@/lib/tools/context";
import { getMcpOAuthClient, MCP_OAUTH_SCOPE, signMcpApproval } from "@/lib/mcp/oauth.server";

export const metadata = { title: "Connect to PropLane", robots: { index: false, follow: false } };

type Search = Record<string, string | string[] | undefined>;
function value(search: Search, key: string): string { const raw = search[key]; return typeof raw === "string" ? raw : ""; }

const CAPABILITIES = [
  { icon: Eye, text: "Read your properties, residents, bookings, payments and messages" },
  { icon: ShieldCheck, text: "Draft changes. Each one waits for your approval in PropLane" },
  { icon: Unplug, text: "Disconnect anytime in Settings → API & MCP" },
] as const;

function initialsFor(label: string): string {
  const parts = label.split(/[\s@._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0]![0]}${parts[1]![0]}` : (parts[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

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
  const { data: profile } = await actor.db.from("profiles").select("full_name").eq("id", actor.userId).maybeSingle();
  const displayName = String(profile?.full_name ?? "").trim() || actor.email.split("@")[0] || "You";
  const clientName = client.clientName?.trim() || "this app";
  return (
    <McpConnectShell>
      <McpConnectHeader />
      <h1 className="mt-6 break-words text-center text-xl font-semibold tracking-tight text-foreground">Connect {clientName} to PropLane</h1>
      <section aria-label="Signed in as" className="mt-6 rounded-xl border border-border p-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary" aria-hidden>{initialsFor(displayName)}</div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">{displayName}</p>
            <p className="truncate text-sm text-muted">{actor.email}</p>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2 border-t border-border pt-3 text-sm text-foreground">
          <Building2 className="h-4 w-4 shrink-0 text-muted" aria-hidden />
          <span className="min-w-0 truncate">{workspaceName}</span>
        </div>
        <div className="mt-3"><McpSwitchAccountLink returnTo={authorizeUrl} /></div>
      </section>
      <ul className="mt-6 space-y-3">
        {CAPABILITIES.map(({ icon: Icon, text }) => (
          <li key={text} className="flex items-start gap-3 text-sm leading-snug text-foreground">
            <Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
            <span>{text}</span>
          </li>
        ))}
      </ul>
      <form action="/api/mcp/oauth/approve" method="post" className="mt-6 space-y-2">
        <input type="hidden" name="approval" value={approval} />
        <Button type="submit" className="w-full" data-attr="mcp-consent-allow">Allow</Button>
        <Button type="submit" variant="secondary" className="w-full" formAction="/api/mcp/oauth/deny" formNoValidate data-attr="mcp-consent-cancel">Cancel</Button>
      </form>
    </McpConnectShell>
  );
}
