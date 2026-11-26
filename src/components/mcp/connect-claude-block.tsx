"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalSettingsGroup, PortalSettingsRow, PortalSettingsSection } from "@/components/portal/portal-settings-ui";
import { MCP_CLAUDE_CODE_COMMAND, MCP_CONNECT_STEPS, MCP_PUBLIC_URL } from "@/lib/mcp/public-url";

function CopyValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <PortalIconAction
      icon={copied ? Check : Copy}
      label={copied ? "Copied" : `Copy ${label}`}
      data-attr={`mcp-copy-${label.toLowerCase().replace(/\s+/g, "-")}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
        } catch {
          setCopied(false);
        }
      }}
    />
  );
}

/**
 * "Connect Claude": the MCP URL and the steps, for the manager's Settings → API & MCP and the resident's
 * Preferences. Label/value rows and one instruction list; no subtext. Connecting twice (two workspaces, or a
 * workspace and "As resident") makes two connections, one each.
 */
export function ConnectClaudeBlock({ includeClaudeCode = false }: { includeClaudeCode?: boolean }) {
  return (
    <PortalSettingsSection title="Connect Claude">
      <div data-attr="settings-mcp-connect-claude">
        <PortalSettingsGroup>
          <PortalSettingsRow label="MCP URL">
            <div className="flex min-w-0 items-center gap-2">
              <code className="max-w-[56vw] truncate text-xs" data-attr="mcp-url-value">{MCP_PUBLIC_URL}</code>
              <CopyValue value={MCP_PUBLIC_URL} label="MCP URL" />
            </div>
          </PortalSettingsRow>
          {includeClaudeCode ? (
            <PortalSettingsRow label="Claude Code">
              <div className="flex min-w-0 items-center gap-2">
                <code className="max-w-[56vw] truncate text-xs">{MCP_CLAUDE_CODE_COMMAND}</code>
                <CopyValue value={MCP_CLAUDE_CODE_COMMAND} label="Claude Code command" />
              </div>
            </PortalSettingsRow>
          ) : null}
        </PortalSettingsGroup>
        <ol className="mt-4 list-decimal space-y-1 pl-5 text-sm text-foreground" data-attr="mcp-connect-steps">
          {MCP_CONNECT_STEPS.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </div>
    </PortalSettingsSection>
  );
}
