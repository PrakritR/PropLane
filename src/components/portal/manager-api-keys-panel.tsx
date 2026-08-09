"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Copy, KeyRound, TriangleAlert } from "lucide-react";

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
    <Button
      variant="outline"
      className="h-9 min-h-0 shrink-0 px-3 text-[13px]"
      data-attr={`api-key-copy-${label}`}
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
      }}
    >
      {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
      {copied ? "Copied" : "Copy"}
    </Button>
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
  const [loaded, setLoaded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [allowedTools, setAllowedTools] = useState<string[]>([]);
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/manager/api-keys", { cache: "no-store" });
      if (!res.ok) throw new Error("Could not load your API keys.");
      const body = (await res.json()) as { keys?: ApiKey[] };
      setKeys(body.keys ?? []);
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

  return (
    <PortalSettingsSection
      title="API & MCP"
      description="Connect an assistant in one command, or create a finely scoped REST API key for your own integration."
      action={
        creating ? null : (
          <Button
            variant="outline"
            className="h-9 min-h-0 px-4 text-[13px]"
            data-attr="api-key-create-open"
            onClick={() => {
              setCreating(true);
              setFreshToken(null);
            }}
          >
            Create API key
          </Button>
        )
      }
    >
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      <PortalSettingsGroup>
        <div className="flex items-center gap-3 px-4 py-3">
          <KeyRound className="h-4 w-4 shrink-0 text-emerald-700 dark:text-emerald-400" aria-hidden />
          <div className="min-w-0 flex-1"><p className="text-sm font-medium text-foreground">MCP server</p><p className="mt-0.5 text-xs leading-relaxed text-muted">Paste this URL into Claude, Cursor, or another MCP client. You’ll sign in with PropLane and approve the connection in your browser.</p></div>
        </div>
        <div className="flex items-center gap-2 border-t border-border px-4 py-3"><code className="min-w-0 flex-1 truncate rounded-md bg-foreground/[0.03] px-2.5 py-2 font-mono text-xs text-foreground">{mcpUrl}</code><CopyButton value={mcpUrl} label="mcp-url" /></div>
      </PortalSettingsGroup>

      {freshToken ? (
        <PortalSettingsGroup className="border-primary/40">
          <div className="space-y-3 p-4">
            <div className="flex items-start gap-2.5">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">Copy this key now</p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted">
                  This is the only time it will be shown. PropLane stores only a hash, so it cannot be
                  recovered — if you lose it, revoke it and create another.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-lg border border-border bg-foreground/[0.03] px-3 py-2 font-mono text-xs text-foreground">
                {freshToken}
              </code>
              <CopyButton value={freshToken} label="token" />
            </div>
            <div>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <p className="text-xs font-medium text-foreground">
                  REST API configuration
                </p>
                <CopyButton value={apiConfig} label="config" />
              </div>
              <pre className="overflow-x-auto rounded-lg border border-border bg-foreground/[0.03] px-3 py-2.5 font-mono text-[11px] leading-relaxed text-foreground">
                {apiConfig}
              </pre>
            </div>
            <Button
              variant="ghost"
              className="h-9 min-h-0 px-3 text-[13px]"
              data-attr="api-key-dismiss-token"
              onClick={() => setFreshToken(null)}
            >
              Done
            </Button>
          </div>
        </PortalSettingsGroup>
      ) : null}

      {creating ? (
        <PortalSettingsGroup>
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
              <p className="mt-1 text-xs leading-relaxed text-muted">Read looks up data. Write can only propose a change; a signed-in manager confirms each proposal in PropLane.</p>
              <div className="mt-2.5 divide-y divide-border rounded-lg border border-border">
                {API_KEY_PRODUCT_AREAS.map((area) => {
                  const read = selectedAreaScopes.includes(`${area.id}:read`);
                  const write = selectedAreaScopes.includes(`${area.id}:write`);
                  return (
                    <div key={area.id} className="flex items-center gap-3 px-3 py-2.5">
                      <div className="min-w-0 flex-1"><p className="text-sm font-medium text-foreground">{area.label}</p><p className="mt-0.5 text-xs text-muted">{area.description}</p></div>
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
            <details className="group rounded-lg border border-border">
              <summary className="cursor-pointer px-3 py-2.5 text-sm font-medium text-foreground marker:text-muted">Advanced tools <span className="ml-1 text-xs font-normal text-muted">Choose individual tools</span></summary>
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
            </details>
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
        </PortalSettingsGroup>
      ) : null}

      <PortalSettingsGroup>
        {!loaded ? (
          <p className="px-4 py-6 text-sm text-muted">Loading…</p>
        ) : keys.length === 0 ? (
          <div className="flex items-start gap-3 px-4 py-6">
            <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">No API keys yet</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted">
                Create one to let your own agent read your portfolio.{" "}
                <a href="/docs/mcp" className="text-primary hover:underline" target="_blank" rel="noreferrer">
                  Read the setup guide
                </a>
                .
              </p>
            </div>
          </div>
        ) : (
          keys.map((key) => (
            <PortalSettingsRow
              key={key.id}
              label={key.name}
              description={
                <>
                  <span className="font-mono">{key.tokenPrefix}…</span> ·{" "}
                  {key.transport === "api" ? "REST API" : "MCP"} · {key.allowedTools.length} tools · Last used{" "}
                  {formatWhen(key.lastUsedAt)} · Created {formatWhen(key.createdAt)}
                </>
              }
            >
              <Button
                variant="danger"
                className="h-9 min-h-0 px-3 text-[13px]"
                data-attr="api-key-revoke"
                onClick={() => revokeKey(key.id)}
              >
                Revoke
              </Button>
            </PortalSettingsRow>
          ))
        )}
      </PortalSettingsGroup>
    </PortalSettingsSection>
  );
}
