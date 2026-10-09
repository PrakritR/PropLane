import { Check } from "lucide-react";
import { McpAutoContinue } from "@/components/mcp/mcp-auto-continue";
import { McpConnectHeader, McpConnectNotice, McpConnectShell } from "@/components/mcp/mcp-connect-ui";
import { Button } from "@/components/ui/button";
import { verifyMcpConnected } from "@/lib/mcp/oauth.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata = {
  title: "PropLane connected",
  robots: { index: false, follow: false },
  // The signed token rides this URL; the client's callback must never see it as a Referer.
  referrer: "no-referrer" as const,
};

type Search = Record<string, string | string[] | undefined>;

export default async function McpConnectedPage({ searchParams }: { searchParams: Promise<Search> }) {
  const search = await searchParams;
  const raw = search.t;
  const payload = typeof raw === "string" ? verifyMcpConnected(raw) : null;
  // Only the signed-in manager who just approved may continue; a copied link is inert.
  let userId: string | null = null;
  if (payload) {
    try {
      const supabase = await createSupabaseServerClient();
      userId = (await supabase.auth.getUser()).data.user?.id ?? null;
    } catch {
      userId = null;
    }
  }
  if (!payload || userId !== payload.userId) {
    return (
      <McpConnectNotice
        title="This link has expired"
        line="Return to your app and connect again; nothing was changed."
      />
    );
  }
  const clientName = payload.clientName || "your app";
  return (
    <McpConnectShell>
      <McpConnectHeader />
      <div className="mt-6 flex flex-col items-center text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600" aria-hidden>
          <Check className="h-6 w-6" strokeWidth={2.25} />
        </div>
        <h1 className="mt-4 text-xl font-semibold tracking-tight text-foreground">PropLane is connected</h1>
        <p className="mt-2 break-words text-sm leading-relaxed text-muted" role="status">
          {clientName} can now use {payload.workspaceName}
        </p>
      </div>
      <Button asChild className="mt-6 w-full">
        <a href={payload.destination} rel="noreferrer" data-attr="mcp-connected-return">
          Return to {clientName}
        </a>
      </Button>
      <McpAutoContinue destination={payload.destination} />
    </McpConnectShell>
  );
}
