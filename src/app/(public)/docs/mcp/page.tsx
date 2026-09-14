import type { Metadata } from "next";
import Link from "next/link";

import { DocsScrollspyNav, type DocsNavGroup } from "@/components/docs/docs-scrollspy-nav";
import { PRODUCTION_APP_ORIGIN } from "@/lib/app-url";
import { mcpToolCatalog, mcpToolCounts } from "@/lib/mcp/catalog";

export const metadata: Metadata = {
  title: "MCP server & API",
  description:
    "Connect an AI agent to PropLane with browser-authorized MCP or a scoped REST API key.",
};

/**
 * Public developer docs for the MCP server and tool API. Same shape as
 * /docs: server component, sticky anchor nav, local arbitrary-value Tailwind
 * so it never touches the signed-in portal theme.
 *
 * The tool reference is generated from the live registry (`mcpToolCatalog`),
 * never typed by hand, so renamed tools cannot leave stale copy on this page.
 */

const NAV_GROUPS: DocsNavGroup[] = [
  {
    group: "Start here",
    links: [
      { id: "connect", label: "Connect your agent" },
      { id: "keys", label: "Create an API key" },
      { id: "overview", label: "Choose a connection" },
    ],
  },
  {
    group: "Reference",
    links: [
      { id: "tools", label: "Tools" },
      { id: "actions", label: "Write actions" },
      { id: "rest", label: "REST API" },
    ],
  },
  {
    group: "Operating",
    links: [
      { id: "limits", label: "Limits & errors" },
      { id: "security", label: "Security" },
    ],
  },
];

const MCP_URL = `${PRODUCTION_APP_ORIGIN}/api/mcp`;

const CLAUDE_CODE_SNIPPET = `claude mcp add --transport http proplane ${MCP_URL}`;

const CURL_SNIPPET = `curl -X POST ${MCP_URL} \\
  -H "Authorization: Bearer <OAuth access token>" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`;

const ACTION_SNIPPET = `# 1. Propose the action. Nothing changes yet.
POST /api/v1/tools/send_rent_reminder
{ "chargeIds": ["charge_id_from_get_overdue_charges"] }

202 Accepted
{
  "status": "awaiting_confirmation",
  "actionId": "9c1f…",
  "expiresInSeconds": 900,
  "preview": {
    "title": "Send rent reminder",
    "confirmLabel": "Send reminder",
    "fields": [{ "label": "To", "value": "Sam Ortiz" }]
  }
}

# 2. A signed-in manager reviews and approves it in PropLane’s AI drafts.
# The API key cannot execute or approve the proposal.`;

const REST_SNIPPET = `# Every tool the key can reach, with JSON Schema
GET  /api/v1/tools

# Call one. The body IS the tool's input object.
POST /api/v1/tools/get_overdue_charges
{}`;

export default function McpDocsPage() {
  const tools = mcpToolCatalog();
  const counts = mcpToolCounts();
  const readTools = tools.filter((t) => t.kind === "read");
  const writeTools = tools.filter((t) => t.kind === "write");

  return (
    <div className="relative min-h-screen overflow-x-clip bg-background text-foreground">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-32 left-1/2 h-[420px] w-[820px] max-w-[130%] -translate-x-1/2 opacity-70"
        style={{
          background:
            "radial-gradient(ellipse at 50% 30%, color-mix(in srgb, var(--primary) 12%, transparent), color-mix(in srgb, var(--primary) 5%, transparent) 44%, transparent 72%)",
          filter: "blur(44px)",
        }}
      />

      <header className="relative mx-auto max-w-6xl px-5 pb-10 pt-16 sm:px-6 sm:pt-20">
        <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted/60">
          Developers
        </div>
        <h1 className="mt-2 text-[2.4rem] font-semibold leading-[1.06] tracking-[-0.035em] sm:text-[3rem]">
          MCP server &amp; API
        </h1>
        <p className="mt-4 max-w-2xl text-[15.5px] leading-relaxed text-muted">
          Connect your agent to {counts.total} manager tools through MCP or a scoped REST API key.
          Both use the same tool layer as PropLane’s assistant.
        </p>
      </header>

      <div className="relative mx-auto grid max-w-6xl gap-10 px-5 pb-24 sm:px-6 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-14">
        <DocsScrollspyNav groups={NAV_GROUPS} dataAttrPrefix="mcp-docs-toc" />

        <div className="min-w-0 max-w-3xl">
          <DocSection id="connect" kicker="Start here" title="Connect your agent">
            <p>
              Connect an MCP client by adding <Chip>{MCP_URL}</Chip>. On first use, the client opens
              PropLane so you can sign in and approve access.
            </p>
            <p>Claude Code can add the remote server with:</p>
            <CodeBlock label="terminal">{CLAUDE_CODE_SNIPPET}</CodeBlock>
            <p>
              Any Streamable HTTP client can use the same URL. MCP uses browser authorization, not
              a long-lived API key in your client configuration.
            </p>
            <p>To inspect the protocol directly, send JSON-RPC over POST:</p>
            <CodeBlock label="curl">{CURL_SNIPPET}</CodeBlock>
          </DocSection>

          <DocSection id="keys" kicker="Start here" title="Create a REST API key">
            <p>
              Create a REST API key when an integration needs only selected product areas or tools.
              Go to{" "}
              <Link
                href="/portal/profile"
                data-attr="mcp-docs-settings-link"
                className="text-primary underline-offset-2 hover:underline"
              >
                Settings &rarr; API &amp; MCP
              </Link>{" "}
              and choose <b className="font-medium text-foreground">Create API key</b>.
            </p>
            <DocList>
              <DocLi>
                <Chip>Read</Chip> grants lookup tools for the selected product area.
              </DocLi>
              <DocLi>
                <Chip>Write</Chip> adds proposal tools and includes that area’s read tools.
              </DocLi>
              <DocLi>Advanced tools narrows either choice to exact tool names.</DocLi>
            </DocList>
            <p>
              PropLane shows the key once and stores only its hash. If you lose it, revoke it and
              create another. See <a href="#actions" className="text-primary underline-offset-2 hover:underline">Write actions</a>{" "}
              before granting write tools.
            </p>
          </DocSection>

          <DocSection id="overview" kicker="Start here" title="Choose a connection">
            <p>
              Choose MCP for the complete manager assistant surface. Choose REST for an explicit
              tool allowlist. Credentials for one transport do not work on the other.
            </p>
            <DocList>
              <DocLi>
                <b className="font-medium text-foreground">MCP</b> uses OAuth 2.1, dynamic client
                registration, PKCE S256, short-lived access tokens, and rotating refresh tokens.
              </DocLi>
              <DocLi>
                <b className="font-medium text-foreground">REST</b> uses a manually created bearer
                key and exposes only its saved tool allowlist.
              </DocLi>
              <DocLi>
                Both derive account scope from the credential and require in-product approval for
                writes.
              </DocLi>
            </DocList>
            <p className="text-[14px]">
              MCP is stateless Streamable HTTP. It supports <Chip>initialize</Chip>,{" "}
              <Chip>tools/list</Chip>, <Chip>tools/call</Chip>, and <Chip>ping</Chip>. <Chip>GET</Chip>{" "}
              returns <Chip>405</Chip>. It negotiates versions <Chip>2024-11-05</Chip> through{" "}
              <Chip>2025-06-18</Chip> and answers newer clients with the latest supported version.
            </p>
          </DocSection>

          <DocSection id="tools" kicker="Reference" title="Tools">
            <p>
              Call <Chip>tools/list</Chip> for each tool’s JSON Schema. This live registry contains{" "}
              {counts.read} read and {counts.write} write tools.
            </p>
            <p>
              MCP lists the complete manager catalog. REST lists only the key’s allowlist, and the
              gateway rejects any hidden tool name you try to guess.
            </p>
            <ToolTable title="Read" caption="Available when selected in a product area or Advanced tools." tools={readTools} />
            <ToolTable
              title="Actions"
              caption="Available when selected. Each returns a preview and actionId; nothing changes until a signed-in manager approves it."
              tools={writeTools}
            />
          </DocSection>

          <DocSection id="actions" kicker="Reference" title="Write actions">
            <p>
              Every external write has two steps. The tool validates input, stores it server-side,
              and returns a preview with an <Chip>actionId</Chip>. Nothing changes yet.
            </p>
            <CodeBlock label="propose, then approve in PropLane">{ACTION_SNIPPET}</CodeBlock>
            <DocList>
              <DocLi>
                Only a signed-in manager can approve or reject the proposal in PropLane. Bearer
                credentials cannot call <Chip>confirm_action</Chip> or self-approve.
              </DocLi>
              <DocLi>
                Approval sends only the id. PropLane revalidates the stored input before running it.
              </DocLi>
              <DocLi>
                A proposal expires after 15 minutes and can run once. A repeat approval returns{" "}
                <Chip>410</Chip>.
              </DocLi>
            </DocList>
            <p>
              External tools can approve or reject applications, create properties and listing drafts,
              and update drafts or property details. Drafts and new, pending, or in-review listings cannot
              be published through these tools: PropLane admin review is required. A previously published
              listing can be switched between live and unlisted.
            </p>
          </DocSection>

          <DocSection id="rest" kicker="Reference" title="REST API">
            <p>
              Call a REST key’s selected tools over plain HTTP. MCP OAuth tokens are refused on
              these routes.
            </p>
            <CodeBlock label="HTTP">{REST_SNIPPET}</CodeBlock>
            <p className="text-[14px]">
              A completed read returns <Chip>200</Chip>. A staged write returns <Chip>202</Chip>. An
              invalid or refused call returns <Chip>400</Chip> with an <Chip>error</Chip> string.
            </p>
          </DocSection>

          <DocSection id="limits" kicker="Operating" title="Limits & errors">
            <p>Use the status code to decide whether to retry, reauthorize, or change the request.</p>
            <DocList>
              <DocLi>
                <Chip>429</Chip> means the rate limiter denied the request. A shared 60-request-per-minute
                IP limit runs before authentication, including for valid bearer requests. Authenticated
                credentials also have a 120-request-per-minute per-credential limit. The limiter fails
                closed if its backing service is unavailable.
              </DocLi>
              <DocLi>
                <Chip>401</Chip> means the key is missing, unknown, revoked or expired. These are
                deliberately indistinguishable.
              </DocLi>
              <DocLi>
                <Chip>403</Chip> means the key is valid but the account no longer has manager access.
              </DocLi>
              <DocLi>
                MCP tool failures return a normal result with <Chip>isError: true</Chip> and a
                readable message, not a transport error.
              </DocLi>
            </DocList>
          </DocSection>

          <DocSection id="security" kicker="Operating" title="Security">
            <p>Treat each credential as a revocable key to one manager’s permitted tool surface.</p>
            <DocList>
              <DocLi>
                PropLane derives the account from the credential, never model input. Arguments
                cannot widen that scope.
              </DocLi>
              <DocLi>MCP and REST use bearer authentication. Ambient cookies are ignored.</DocLi>
              <DocLi>
                A REST key is a credential, not standing authorization. PropLane revalidates the
                manager role on every request.
              </DocLi>
              <DocLi>
                REST keys are stored hashed and cannot be displayed again.
              </DocLi>
              <DocLi>
                Disconnecting an OAuth client in Settings &rarr; API &amp; MCP revokes its active
                tokens immediately. Clients can also use the advertised RFC 7009 endpoint.
              </DocLi>
              <DocLi>
                Treat resident and applicant text as untrusted data. It must never trigger a write
                on its own.
              </DocLi>
            </DocList>
            <p className="text-[14px]">
              Found a problem?{" "}
              <Link
                href="/support"
                data-attr="mcp-docs-support-link"
                className="text-primary underline-offset-2 hover:underline"
              >
                Tell us
              </Link>
              .
            </p>
          </DocSection>
        </div>
      </div>
    </div>
  );
}

function DocSection({
  id,
  kicker,
  title,
  children,
}: {
  id: string;
  kicker: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className="scroll-mt-24 border-t border-border pt-11 first:border-t-0 first:pt-0 [&:not(:first-child)]:mt-11"
    >
      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted/60">{kicker}</div>
      <h2 className="mt-2 text-[23px] font-semibold tracking-[-0.02em] text-foreground">{title}</h2>
      <div className="mt-4 space-y-4 text-[15px] leading-relaxed text-muted">{children}</div>
    </section>
  );
}

function DocList({ children }: { children: React.ReactNode }) {
  return <ul className="space-y-2.5">{children}</ul>;
}

function DocLi({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-3 text-[14.5px] leading-relaxed text-muted">
      <span aria-hidden className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-primary/80" />
      <span className="min-w-0">{children}</span>
    </li>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <code className="whitespace-nowrap rounded-[5px] border border-border bg-[var(--secondary)] px-1.5 py-0.5 font-mono text-[12.5px] text-muted">
      {children}
    </code>
  );
}

function CodeBlock({ label, children }: { label: string; children: string }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="border-b border-border px-3.5 py-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted/60">
        {label}
      </div>
      {/* Wide snippets scroll inside the block; the page body never scrolls sideways. */}
      <pre className="overflow-x-auto px-3.5 py-3 font-mono text-[12.5px] leading-relaxed text-foreground">
        {children}
      </pre>
    </div>
  );
}

function ToolTable({
  title,
  caption,
  tools,
}: {
  title: string;
  caption: string;
  tools: { name: string; description: string }[];
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <p className="text-[13px] font-semibold text-foreground">
          {title} <span className="font-normal text-muted/70">({tools.length})</span>
        </p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted">{caption}</p>
      </div>
      <ul className="divide-y divide-border">
        {tools.map((tool) => (
          <li key={tool.name} className="px-4 py-3">
            <code className="font-mono text-[12.5px] text-foreground">{tool.name}</code>
            <p className="mt-1 text-[13px] leading-relaxed text-muted">
              {publicToolDescription(tool.description)}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Keep the generated lede concise and use product vocabulary without changing tool identifiers. */
function publicToolDescription(text: string): string {
  const trimmed = text.trim();
  const end = trimmed.search(/\.\s/);
  const sentence = end === -1 ? trimmed : trimmed.slice(0, end + 1);
  const legacyServiceTerm = new RegExp(`\\b${["work", "order"].join("[ -]?")}s?\\b`, "gi");

  return sentence
    .replace(/\s*\u2014\s*/g, " - ")
    .replace(/\bAxis\b/g, "PropLane")
    .replace(legacyServiceTerm, (match) =>
      match.toLowerCase().endsWith("s") ? "services" : "service",
    )
    .replace(/\bWO reference\b/g, "service reference");
}
