import { redirect } from "next/navigation";
import { resolveAgentContext } from "@/lib/tools/context";
import { getMcpOAuthClient, MCP_OAUTH_SCOPE, signMcpApproval } from "@/lib/mcp/oauth.server";

export const metadata = { title: "Authorize MCP connection" };

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
  const actor = await resolveAgentContext();
  if (!actor) {
    const params = new URLSearchParams();
    for (const [key, raw] of Object.entries(search)) if (typeof raw === "string") params.set(key, raw);
    redirect(`/auth/sign-in?next=${encodeURIComponent(`/mcp/authorize?${params.toString()}`)}`);
  }
  const client = await getMcpOAuthClient(actor.db, clientId);
  const valid = responseType === "code" && method === "S256" && challenge.length >= 43 && scope.split(/\s+/).every((item) => item === MCP_OAUTH_SCOPE) && Boolean(client?.redirectUris.includes(redirectUri));
  if (!valid || !client) {
    return <main className="mx-auto flex min-h-screen max-w-lg items-center px-6"><div className="w-full rounded-xl border border-danger/30 bg-danger/5 p-6"><h1 className="text-lg font-semibold text-foreground">Couldn’t authorize this connection</h1><p className="mt-2 text-sm leading-relaxed text-muted">The MCP client sent an invalid or expired authorization request. Return to the client and try connecting again.</p></div></main>;
  }
  const approval = signMcpApproval({ userId: actor.userId, clientId, redirectUri, codeChallenge: challenge, scope, state });
  if (!approval) {
    return <main className="mx-auto flex min-h-screen max-w-lg items-center px-6"><div className="w-full rounded-xl border border-danger/30 bg-danger/5 p-6"><h1 className="text-lg font-semibold text-foreground">Couldn’t authorize this connection</h1><p className="mt-2 text-sm leading-relaxed text-muted">Authorization is temporarily unavailable. Return to the MCP client and try again.</p></div></main>;
  }
  return (
    <main className="mx-auto flex min-h-screen max-w-lg items-center px-6 py-10">
      <form action="/api/mcp/oauth/approve" method="post" className="w-full rounded-xl border border-border bg-card p-6 shadow-sm">
        <p className="text-xs font-medium uppercase tracking-[0.08em] text-muted">PropLane MCP</p>
        <h1 className="mt-2 text-xl font-semibold tracking-tight text-foreground">Allow {client.clientName || "this client"} to connect?</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted">It will be able to use your manager assistant tools. Actions that change PropLane data still require a preview and confirmation.</p>
        <input type="hidden" name="approval" value={approval} />
        <div className="mt-6 flex gap-2"><button type="submit" className="min-h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2">Allow connection</button><button type="submit" formAction="/api/mcp/oauth/deny" className="min-h-10 rounded-md px-3 text-sm text-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">Cancel</button></div>
      </form>
    </main>
  );
}
