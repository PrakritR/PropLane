"use client";

/**
 * "Connected apps": the MCP connections this ACCOUNT holds, with Disconnect. One section for both portals —
 * `GET` / `DELETE /api/manager/mcp-connections` answer a manager context or a resident one, so a resident who
 * connected Claude "As resident" revokes it from their own Settings instead of having no screen for it.
 */
import { useCallback, useEffect, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  PortalSettingsGroup,
  PortalSettingsRow,
  PortalSettingsSection,
} from "@/components/portal/portal-settings-ui";
import { MCP_OAUTH_SCOPE_LABEL } from "@/lib/mcp/oauth-scope-label";

export type McpConnection = {
  clientId: string;
  portal?: "manager" | "resident";
  clientName: string | null;
  createdAt: string;
  lastUsedAt: string | null;
};

export function formatMcpConnectionWhen(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Never";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function McpConnectionsSection() {
  const [connections, setConnections] = useState<McpConnection[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ clientId: string; name: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/manager/mcp-connections", { cache: "no-store" });
      if (!res.ok) throw new Error("Could not load your connected apps.");
      const body = (await res.json()) as { connections?: McpConnection[] };
      setConnections(body.connections ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load your connected apps.");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const disconnect = async (clientId: string) => {
    setError(null);
    const res = await fetch(`/api/manager/mcp-connections/${encodeURIComponent(clientId)}`, { method: "DELETE" });
    if (!res.ok) {
      setError("Could not disconnect that app.");
      return;
    }
    setConnections((current) => current.filter((connection) => connection.clientId !== clientId));
  };

  return (
    <PortalSettingsSection title="Connected apps">
      {error ? <p role="alert" className="mb-2 text-sm text-danger">{error}</p> : null}
      <PortalSettingsGroup>
        {!loaded ? (
          <PortalSettingsRow label="Loading…" />
        ) : connections.length === 0 ? (
          <PortalSettingsRow label="Claude">
            <span className="text-[13px] text-foreground/80" data-attr="settings-mcp-claude-status">Not connected</span>
          </PortalSettingsRow>
        ) : (
          connections.map((connection) => (
            <PortalSettingsRow key={connection.clientId} label={connection.clientName || "MCP client"}>
              <div className="flex flex-wrap items-center justify-end gap-x-2">
                <span className="text-[13px] text-foreground/80" data-attr="mcp-connection-row-value">
                  {formatMcpConnectionWhen(connection.createdAt)} · {connection.portal === "resident" ? "As resident" : MCP_OAUTH_SCOPE_LABEL}
                </span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <PortalIconAction icon={MoreHorizontal} label={`${connection.clientName || "MCP client"} actions`} />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      className="text-danger"
                      onSelect={() => setPending({ clientId: connection.clientId, name: connection.clientName || "MCP client" })}
                    >
                      Disconnect
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </PortalSettingsRow>
          ))
        )}
      </PortalSettingsGroup>
      {pending ? (
        <PortalDialog
          open
          tone="danger"
          onClose={() => setPending(null)}
          title="Disconnect app"
          fullScreenMobile={false}
          primaryAction={{
            label: "Disconnect",
            onClick: () => {
              const target = pending;
              setPending(null);
              return target ? disconnect(target.clientId) : Promise.resolve();
            },
            dataAttr: "mcp-connection-disconnect-confirm",
          }}
        >
          <div className="p-4">
            <PortalSettingsGroup>
              <PortalSettingsRow label="App">
                <span className="text-[15px] font-medium text-foreground">{pending.name}</span>
              </PortalSettingsRow>
            </PortalSettingsGroup>
          </div>
        </PortalDialog>
      ) : null}
    </PortalSettingsSection>
  );
}
