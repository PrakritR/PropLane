"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Copy, TriangleAlert, MoreHorizontal } from "lucide-react";

import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useConfirm } from "@/components/providers/app-ui-provider";
import { Button } from "@/components/ui/button";
import {
  PortalSettingsGroup,
  PortalSettingsRow,
  PortalSettingsSection,
} from "@/components/portal/portal-settings-ui";
import { cn } from "@/lib/utils";
import {
  API_KEY_PRODUCT_AREAS,
  productAreaSelectionsForTools,
  toolsForProductAreas,
  type ApiKeyTransport,
} from "@/lib/mcp/capabilities";
import { MCP_OAUTH_SCOPE_LABEL } from "@/lib/mcp/oauth-scope-label";
import { WEBHOOK_EVENT_TYPES, type WebhookEventType } from "@/lib/webhooks/events";

function SettingsActions({ label, actions }: { label: string; actions: { label: string; run: () => Promise<void>; danger?: boolean }[] }) {
  const confirm = useConfirm();
  return <DropdownMenu><DropdownMenuTrigger asChild><PortalIconAction icon={MoreHorizontal} label={`${label} actions`} /></DropdownMenuTrigger><DropdownMenuContent align="end">{actions.map((action) => <DropdownMenuItem key={action.label} className={action.danger ? "text-danger" : undefined} onSelect={async () => { if (action.danger && !await confirm({ title: action.label, description: `${action.label} ${label}?`, confirmLabel: action.label })) return; await action.run(); }}>{action.label}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>;
}

type ApiKey = {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  allowedTools: string[];
  transport: ApiKeyTransport;
  createdAt: string;
  lastUsedAt: string | null;
};

type McpConnection = {
  clientId: string;
  clientName: string | null;
  createdAt: string;
  lastUsedAt: string | null;
};

function formatWhen(value: string | null): string {
  if (!value) return "Never";
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) return "Unknown";
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <PortalIconAction icon={copied ? Check : Copy} label={copied ? "Copied" : `Copy ${label}`} data-attr={`api-key-copy-${label}`} onClick={async () => { await navigator.clipboard.writeText(value); setCopied(true); }} />
  );
}

type WebhookSubscription = {
  id: string;
  url: string;
  events: WebhookEventType[];
  enabled: boolean;
  createdAt: string;
  failureCount: number;
  lastDelivery: { eventType: string; status: string; responseStatus: number | null; at: string | null } | null;
};

/**
 * Outbound webhooks. PropLane POSTs a signed, ids-and-statuses-only event to a
 * URL the manager owns.
 *
 * The signing secret is shown exactly once — on create and on rotate — for the
 * same reason an API key is: PropLane can reproduce it to sign, but handing it
 * back on a list read would make every later request a way to recover it.
 */
function ManagerWebhooksBlock() {
  const [webhooks, setWebhooks] = useState<WebhookSubscription[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<WebhookEventType[]>([]);
  const [freshSecret, setFreshSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/portal/webhooks", { cache: "no-store" });
      if (!res.ok) throw new Error("Could not load your webhooks.");
      const body = (await res.json()) as { webhooks?: WebhookSubscription[] };
      setWebhooks(body.webhooks ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load your webhooks.");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const toggleEvent = (type: WebhookEventType) =>
    setEvents((current) => (current.includes(type) ? current.filter((t) => t !== type) : [...current, type]));

  const create = async () => {
    setError(null);
    setTestResult(null);
    const res = await fetch("/api/portal/webhooks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, events }),
    });
    const body = (await res.json().catch(() => ({}))) as { secret?: string; error?: string };
    if (!res.ok || !body.secret) {
      setError(body.error ?? "Could not save that webhook.");
      return;
    }
    setFreshSecret(body.secret);
    setAdding(false);
    setUrl("");
    setEvents([]);
    await load();
  };

  const rotate = async (id: string) => {
    setError(null);
    const res = await fetch(`/api/portal/webhooks/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "rotate" }),
    });
    const body = (await res.json().catch(() => ({}))) as { secret?: string; error?: string };
    if (!res.ok || !body.secret) {
      setError(body.error ?? "Could not rotate that secret.");
      return;
    }
    setFreshSecret(body.secret);
  };

  const sendTest = async (id: string) => {
    setError(null);
    setTestResult(null);
    const res = await fetch(`/api/portal/webhooks/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "test" }),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; status?: number | null; error?: string | null };
    setTestResult(body.ok ? `Test event delivered (HTTP ${body.status ?? 200}).` : `Test event failed: ${body.error ?? "no response"}`);
    await load();
  };

  const remove = async (id: string) => {
    setError(null);
    const res = await fetch(`/api/portal/webhooks/${id}`, { method: "DELETE" });
    if (!res.ok) {
      setError("Could not delete that webhook.");
      return;
    }
    setWebhooks((current) => current.filter((hook) => hook.id !== id));
  };

  return (
    <PortalSettingsGroup>

      {error ? (
        <p role="alert" className="border-b border-border px-4 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
      {testResult ? (
        <p role="status" className="border-b border-border px-4 py-2 text-xs text-muted">
          {testResult}
        </p>
      ) : null}

      {freshSecret ? (
        <div className="space-y-2 border-b border-border px-4 py-3">
          <div className="flex items-start gap-2.5">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
            <p className="text-xs leading-relaxed text-muted">
              <span className="font-semibold text-foreground">Copy this signing secret now.</span> It is
              shown only once. Use it to verify the <code className="font-mono">PropLane-Signature</code>{" "}
              header on every delivery.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg border border-border bg-foreground/[0.03] px-3 py-2 font-mono text-xs text-foreground">
              {freshSecret}
            </code>
            <CopyButton value={freshSecret} label="webhook-secret" />
          </div>
          <Button variant="ghost" className="h-9 min-h-0 px-3 text-[13px]" data-attr="webhook-dismiss-secret" onClick={() => setFreshSecret(null)}>
            Done
          </Button>
        </div>
      ) : null}

      {adding ? (
        <PortalDialog open={adding} onClose={() => setAdding(false)} title="Add webhook endpoint" primaryAction={null}><div className="space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-foreground">Endpoint URL</span>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/proplane/webhook"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              data-attr="webhook-url-input"
              className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground outline-none transition-colors focus-visible:border-primary/40 focus-visible:ring-2 focus-visible:ring-primary/20"
            />
          </label>
          <fieldset>
            <legend className="text-sm font-medium text-foreground">Events</legend>
            <div className="mt-2 grid gap-1 sm:grid-cols-2">
              {WEBHOOK_EVENT_TYPES.map((type) => (
                <label key={type} className="flex min-w-0 cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-foreground/[0.03]">
                  <input
                    type="checkbox"
                    checked={events.includes(type)}
                    onChange={() => toggleEvent(type)}
                    data-attr={`webhook-event-${type}`}
                    className="h-3.5 w-3.5 accent-foreground"
                  />
                  <span className="truncate font-mono text-foreground">{type}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex items-center gap-2">
            <Button
              className="h-9 min-h-0 px-4 text-[13px]"
              disabled={!url.trim() || events.length === 0}
              data-attr="webhook-add-submit"
              onClick={() => create()}
            >
              Add endpoint
            </Button>
            <Button
              variant="ghost"
              className="h-9 min-h-0 px-3 text-[13px]"
              data-attr="webhook-add-cancel"
              onClick={() => {
                setAdding(false);
                setUrl("");
                setEvents([]);
              }}
            >
              Cancel
            </Button>
          </div>
        </div></PortalDialog>
      ) : null}

      {!loaded ? (
        <p className="px-4 py-6 text-sm text-muted">Loading…</p>
      ) : webhooks.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted">No webhook endpoints yet.</p>
      ) : (
        webhooks.map((hook) => (
          <PortalSettingsRow
            key={hook.id}
            label={hook.url}
          >
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
              <span className="text-xs text-muted" data-attr="webhook-row-value">
                {hook.events.join(", ") || "No events"} · {hook.enabled ? "Enabled" : "Disabled"}
              </span>
              <SettingsActions label={hook.url} actions={[
                { label: "Send test event", run: () => sendTest(hook.id) },
                { label: "Rotate secret", run: () => rotate(hook.id) },
                { label: "Delete", run: () => remove(hook.id), danger: true },
              ]} />
            </div>
          </PortalSettingsRow>
        ))
      )}
      <button type="button" className="min-h-12 w-full px-4 text-left text-[15px] text-primary" onClick={() => { setAdding(true); setFreshSecret(null); }} aria-label="Add webhook endpoint" data-attr="webhook-add-open">+ Add webhook endpoint</button>
    </PortalSettingsGroup>
  );
}

/**
 * Settings → API & MCP. Mints and revokes the bearer keys a third-party agent
 * harness uses against `/api/mcp`.
 *
 * The plaintext token is shown ONCE, right after creation, and is not
 * recoverable — the server stores only its sha256. Everything else in this
 * panel works off the display prefix.
 */
export function ManagerApiKeysPanel() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [connections, setConnections] = useState<McpConnection[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [allowedTools, setAllowedTools] = useState<string[]>([]);
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [claudeStepsOpen, setClaudeStepsOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{ kind: "key" | "app"; id: string; name: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [keysResponse, connectionsResponse] = await Promise.all([
        fetch("/api/manager/api-keys", { cache: "no-store" }),
        fetch("/api/manager/mcp-connections", { cache: "no-store" }),
      ]);
      if (!keysResponse.ok || !connectionsResponse.ok) throw new Error("Could not load your connections.");
      const [keysBody, connectionsBody] = await Promise.all([
        keysResponse.json() as Promise<{ keys?: ApiKey[] }>,
        connectionsResponse.json() as Promise<{ connections?: McpConnection[] }>,
      ]);
      setKeys(keysBody.keys ?? []);
      setConnections(connectionsBody.connections ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load your API keys.");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    // Schedule after paint so the initial settings shell remains responsive.
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const apiConfig = useMemo(() => {
    const origin = typeof window === "undefined" ? "https://prop-lane.space" : window.location.origin;
    return JSON.stringify({ baseUrl: `${origin}/api/v1/tools`, headers: { Authorization: `Bearer ${freshToken ?? "YOUR_KEY"}` } }, null, 2);
  }, [freshToken]);
  const mcpUrl = useMemo(() => (typeof window === "undefined" ? "https://prop-lane.space" : window.location.origin) + "/api/mcp", []);

  const selectedAreaScopes = useMemo(() => productAreaSelectionsForTools(allowedTools), [allowedTools]);
  const toggleArea = (areaId: string, level: "read" | "write") => {
    const key = `${areaId}:${level}`;
    const nextScopes = new Set(selectedAreaScopes);
    if (level === "write") {
      if (nextScopes.has(key)) {
        nextScopes.delete(key);
      } else {
        nextScopes.add(`${areaId}:read`);
        nextScopes.add(key);
      }
    } else if (nextScopes.has(key)) {
      nextScopes.delete(key);
      nextScopes.delete(`${areaId}:write`);
    } else {
      nextScopes.add(key);
    }
    setAllowedTools(toolsForProductAreas([...nextScopes]));
  };

  const toggleTool = (tool: string) => {
    setAllowedTools((current) =>
      current.includes(tool) ? current.filter((candidate) => candidate !== tool) : [...current, tool],
    );
  };

  const createKey = async () => {
    setError(null);
    const res = await fetch("/api/manager/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, transport: "api", scopes: selectedAreaScopes, allowedTools }),
    });
    const body = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
    if (!res.ok || !body.token) {
      setError(body.error ?? "Could not create the key.");
      return;
    }
    setFreshToken(body.token);
    setCreating(false);
    setName("");
    setAllowedTools([]);
    await load();
  };

  const revokeKey = async (id: string) => {
    setError(null);
    const res = await fetch(`/api/manager/api-keys/${id}`, { method: "DELETE" });
    if (!res.ok) {
      setError("Could not revoke that key.");
      return;
    }
    setKeys((prev) => prev.filter((k) => k.id !== id));
  };

  /** There is no in-place rotate: mint a replacement with the same name and tools, then revoke the old key. */
  const rotateKey = async (key: ApiKey) => {
    setError(null);
    const res = await fetch("/api/manager/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: key.name, transport: key.transport, scopes: key.scopes, allowedTools: key.allowedTools }),
    });
    const body = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
    if (!res.ok || !body.token) {
      setError(body.error ?? "Could not rotate that key.");
      return;
    }
    setFreshToken(body.token);
    await revokeKey(key.id);
    await load();
  };

  const confirmDelete = async () => {
    const target = pendingDelete;
    if (!target) return;
    setPendingDelete(null);
    if (target.kind === "key") await revokeKey(target.id);
    else await revokeMcpConnection(target.id);
  };

  const revokeMcpConnection = async (clientId: string) => {
    setError(null);
    const res = await fetch(`/api/manager/mcp-connections/${encodeURIComponent(clientId)}`, { method: "DELETE" });
    if (!res.ok) {
      setError("Could not disconnect that MCP client.");
      return;
    }
    setConnections((current) => current.filter((connection) => connection.clientId !== clientId));
  };

  const claudeCommand = `claude mcp add --transport http proplane ${mcpUrl}`;

  return (
    <div className="space-y-6" data-attr="settings-api">
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      {freshToken ? (
        <PortalDialog
          open
          onClose={() => setFreshToken(null)}
          title="Copy this key now"
          primaryAction={{ label: "Done", onClick: () => setFreshToken(null), dataAttr: "api-key-dismiss-token" }}
        >
          <div className="p-4" data-attr="api-key-fresh">
            <PortalSettingsGroup>
              <PortalSettingsRow label="Key">
                <div className="flex min-w-0 items-center gap-2">
                  <code className="max-w-[44vw] truncate font-mono text-xs text-foreground">{freshToken}</code>
                  <CopyButton value={freshToken} label="token" />
                </div>
              </PortalSettingsRow>
              <PortalSettingsRow label="REST config">
                <CopyButton value={apiConfig} label="config" />
              </PortalSettingsRow>
            </PortalSettingsGroup>
          </div>
        </PortalDialog>
      ) : null}

      {creating ? (
        <PortalDialog open={creating} onClose={() => setCreating(false)} title="Create API key" primaryAction={null}>
          <div className="space-y-4 p-4">
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-foreground">Key name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My Claude Code setup"
                maxLength={80}
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground outline-none transition-colors focus-visible:border-primary/40 focus-visible:ring-2 focus-visible:ring-primary/20"
              />
            </label>
            <fieldset>
              <legend className="text-sm font-medium text-foreground">Product permissions</legend>
              
              <div className="mt-2.5 divide-y divide-border rounded-lg border border-border">
                {API_KEY_PRODUCT_AREAS.map((area) => {
                  const read = selectedAreaScopes.includes(`${area.id}:read`);
                  const write = selectedAreaScopes.includes(`${area.id}:write`);
                  return (
                    <div key={area.id} className="flex items-center gap-3 px-3 py-2.5">
                      <div className="min-w-0 flex-1"><p className="text-sm font-medium text-foreground">{area.label}</p></div>
                      <div className="flex shrink-0 items-center gap-2 text-[11px] text-muted">
                        {(["read", "write"] as const).map((level) => (
                          <label key={level} className="flex cursor-pointer items-center gap-1.5 rounded-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-foreground/45">
                            <input type="checkbox" className="sr-only" checked={level === "read" ? read : write} onChange={() => toggleArea(area.id, level)} data-attr={`api-key-${area.id}-${level}`} />
                            <span aria-hidden className={cn("flex h-4 w-7 items-center rounded-full p-0.5 transition-colors", (level === "read" ? read : write) ? "justify-end bg-emerald-600/75 dark:bg-emerald-400/65" : "justify-start bg-slate-300 dark:bg-slate-700")}><span className="h-3 w-3 rounded-full bg-background shadow-sm" /></span>
                            {level === "read" ? "Read" : "Write"}
                          </label>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </fieldset>
            <PortalSettingsGroup>
              <PortalSettingsRow label="Advanced tools">
                <Button variant="ghost" className="h-9 min-h-0 px-3 text-[13px]" aria-expanded={advancedOpen} data-attr="api-key-advanced-toggle" onClick={() => setAdvancedOpen((open) => !open)}>{advancedOpen ? "Hide" : "Choose"}</Button>
              </PortalSettingsRow>
            </PortalSettingsGroup>
            {advancedOpen ? (
              <div className="max-h-72 space-y-3 overflow-y-auto border-t border-border p-3">
                {API_KEY_PRODUCT_AREAS.map((area) => (
                  <div key={area.id}><p className="mb-1.5 text-xs font-semibold text-muted">{area.label}</p><div className="grid gap-1 sm:grid-cols-2">
                    {[...area.readTools, ...area.writeTools].map((tool) => (
                      <label key={tool} className="flex min-w-0 cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-foreground/[0.03]">
                        <input type="checkbox" checked={allowedTools.includes(tool)} onChange={() => toggleTool(tool)} data-attr={`api-key-tool-${tool}`} className="h-3.5 w-3.5 accent-foreground" />
                        <span className="truncate font-mono text-foreground">{tool}</span><span className="ml-auto text-[10px] text-muted">{area.writeTools.includes(tool) ? "write" : "read"}</span>
                      </label>
                    ))}
                  </div></div>
                ))}
              </div>
            ) : null}
            <div className="flex items-center gap-2">
              <Button
                className="h-9 min-h-0 px-4 text-[13px]"
                disabled={!name.trim() || allowedTools.length === 0}
                data-attr="api-key-create-submit"
                onClick={() => createKey()}
              >
                Create API key
              </Button>
              <Button
                variant="ghost"
                className="h-9 min-h-0 px-3 text-[13px]"
                data-attr="api-key-create-cancel"
                onClick={() => {
                  setCreating(false);
                  setName("");
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        </PortalDialog>
      ) : null}

      <PortalSettingsSection
        title="API keys"
        action={
          <PortalPrimaryIconAction
            label="Create API key"
            data-attr="api-key-create-open"
            onClick={() => {
              setCreating(true);
              setFreshToken(null);
            }}
          />
        }
      >
        <PortalSettingsGroup>
          {!loaded ? (
            <PortalSettingsRow label="Loading…" />
          ) : keys.length === 0 ? (
            <PortalSettingsRow label="No keys" />
          ) : (
            keys.map((key) => (
              <PortalSettingsRow key={key.id} label={key.name}>
                <div className="flex flex-wrap items-center justify-end gap-x-2">
                  <span className="text-[13px] text-foreground/80" data-attr="api-key-row-value">
                    {formatWhen(key.createdAt)} · {key.lastUsedAt ? formatWhen(key.lastUsedAt) : "Never used"}
                  </span>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <PortalIconAction icon={MoreHorizontal} label={`${key.name} actions`} />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => void navigator.clipboard.writeText(`${key.tokenPrefix}…`)}>Copy key prefix</DropdownMenuItem>
                      {key.transport === "api" ? <DropdownMenuItem onSelect={() => void rotateKey(key)}>Rotate</DropdownMenuItem> : null}
                      <DropdownMenuItem className="text-danger" onSelect={() => setPendingDelete({ kind: "key", id: key.id, name: key.name })}>Delete</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </PortalSettingsRow>
            ))
          )}
        </PortalSettingsGroup>
      </PortalSettingsSection>

      <PortalSettingsSection title="Connected apps">
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
                    {formatWhen(connection.createdAt)} · {MCP_OAUTH_SCOPE_LABEL}
                  </span>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <PortalIconAction icon={MoreHorizontal} label={`${connection.clientName || "MCP client"} actions`} />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem className="text-danger" onSelect={() => setPendingDelete({ kind: "app", id: connection.clientId, name: connection.clientName || "MCP client" })}>Disconnect</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </PortalSettingsRow>
            ))
          )}
        </PortalSettingsGroup>
      </PortalSettingsSection>

      <PortalSettingsSection title="Claude setup">
        <PortalSettingsGroup>
          <PortalSettingsRow label={<button type="button" className="text-left text-[15px] text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-primary/30" data-attr="settings-mcp-claude-connect" onClick={() => setClaudeStepsOpen(true)}>Claude</button>}>
            <CopyButton value={claudeCommand} label="claude-setup" />
          </PortalSettingsRow>
        </PortalSettingsGroup>
      </PortalSettingsSection>

      {claudeStepsOpen ? (
        <PortalDialog open={claudeStepsOpen} onClose={() => setClaudeStepsOpen(false)} title="Claude setup" primaryAction={null}>
          <div className="space-y-4 p-4" data-attr="settings-mcp-claude-steps">
            <PortalSettingsGroup>
              <PortalSettingsRow label="Server URL">
                <div className="flex min-w-0 items-center gap-2"><code className="max-w-[48vw] truncate text-xs">{mcpUrl}</code><CopyButton value={mcpUrl} label="mcp-url" /></div>
              </PortalSettingsRow>
              <PortalSettingsRow label="Claude Code">
                <div className="flex min-w-0 items-center gap-2"><code className="max-w-[48vw] truncate text-xs">{claudeCommand}</code><CopyButton value={claudeCommand} label="claude-command" /></div>
              </PortalSettingsRow>
            </PortalSettingsGroup>
            <ol className="list-decimal space-y-1 pl-5 text-sm text-foreground">
              <li>claude.ai → Settings → Connectors → Add custom connector.</li>
              <li>Name PropLane, paste the Server URL, leave client ID and secret blank, save.</li>
              <li>Connect, then Allow.</li>
            </ol>
          </div>
        </PortalDialog>
      ) : null}

      <PortalSettingsSection title="Webhooks"><ManagerWebhooksBlock /></PortalSettingsSection>

      {pendingDelete ? (
        <PortalDialog
          open
          tone="danger"
          onClose={() => setPendingDelete(null)}
          title={pendingDelete.kind === "key" ? "Delete API key" : "Disconnect app"}
          fullScreenMobile={false}
          primaryAction={{
            label: pendingDelete.kind === "key" ? "Delete key" : "Disconnect",
            onClick: () => confirmDelete(),
            dataAttr: "api-key-delete-confirm",
          }}
        >
          <div className="p-4">
            <PortalSettingsGroup>
              <PortalSettingsRow label={pendingDelete.kind === "key" ? "Key" : "App"}>
                <span className="text-[15px] font-medium text-foreground">{pendingDelete.name}</span>
              </PortalSettingsRow>
            </PortalSettingsGroup>
          </div>
        </PortalDialog>
      ) : null}
    </div>
  );
}
