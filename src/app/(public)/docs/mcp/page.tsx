import type { Metadata } from "next";
import Link from "next/link";

import { PRODUCTION_APP_ORIGIN } from "@/lib/app-url";
import { mcpToolCatalog, mcpToolCounts } from "@/lib/mcp/catalog";

export const metadata: Metadata = {
  title: "MCP server & API",
  description:
    "Connect your own AI agent to PropLane. An MCP server and a plain HTTP API over the same tools the built-in assistant uses, authenticated with a scoped API key.",
};

/**
 * Public developer docs for the MCP server and tool API. Same shape as
 * /docs: server component, sticky anchor nav, local arbitrary-value Tailwind
 * so it never touches the signed-in portal theme.
 *
 * The tool reference is GENERATED from the live registry (`mcpToolCatalog`),
 * never typed by hand — a renamed tool cannot leave a lie behind on this page.
 */

type NavGroup = { group: string; links: { id: string; label: string }[] };

const NAV_GROUPS: NavGroup[] = [
  {
    group: "Start here",
    links: [
      { id: "overview", label: "What this is" },
      { id: "keys", label: "Create an API key" },
      { id: "connect", label: "Connect your agent" },
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

const ACTION_SNIPPET = `# 1. Propose. Nothing is written.
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

# 2. Show the preview to your user. Then execute.
POST /api/v1/tools/confirm_action
{ "actionId": "9c1f…" }

200 OK
{ "status": "executed", "reply": "Reminder sent to Sam Ortiz." }`;

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
    <div className="relative min-h-screen bg-background text-foreground">
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
          Run PropLane from your own AI agent. The same {counts.total} tools that power the built-in
          assistant, exposed over the Model Context Protocol and a plain HTTP API, so you can bring
          whatever harness you already use.
        </p>
      </header>

      <div className="relative mx-auto grid max-w-6xl gap-10 px-5 pb-24 sm:px-6 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-14">
        <nav
          aria-label="Docs sections"
          className="rounded-xl border border-border bg-card p-4 lg:sticky lg:top-24 lg:h-fit lg:rounded-none lg:border-0 lg:bg-transparent lg:p-0"
        >
          <div className="mb-3 px-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted/60 lg:hidden">
            On this page
          </div>
          {NAV_GROUPS.map((g) => (
            <div key={g.group} className="mb-5 last:mb-0">
              <div className="px-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted/60">
                {g.group}
              </div>
              <ul className="mt-1.5 space-y-0.5 border-l border-border lg:pl-0">
                {g.links.map((l) => (
                  <li key={l.id}>
                    <a
                      href={`#${l.id}`}
                      className="-ml-px block border-l border-transparent px-3 py-1.5 text-[13px] text-muted transition-colors hover:border-primary hover:text-foreground"
                    >
                      {l.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <div className="min-w-0 max-w-3xl">
          <DocSection id="overview" kicker="Start here" title="What this is">
            <p>
              PropLane exposes its whole capability surface as typed, permission-scoped tools. The
              assistant inside the product calls those tools; this page is how <em>your</em> agent
              calls the same ones, with the same per-account scoping and the same confirmation gate
              on anything that changes data.
            </p>
            <DocList>
              <DocLi>
                <b className="font-medium text-foreground">One endpoint</b>: <Chip>{MCP_URL}</Chip>,
                stateless Streamable HTTP. No install, no local process, nothing to keep running.
              </DocLi>
              <DocLi>
                <b className="font-medium text-foreground">Browser sign-in for MCP</b>: paste the
                server URL, then authenticate and approve the connection in PropLane.
              </DocLi>
              <DocLi>
                <b className="font-medium text-foreground">Every number is tool-grounded.</b>{" "}
                Balances, dates and statuses come from tool results, so your agent reports what
                PropLane actually holds rather than an estimate.
              </DocLi>
            </DocList>
            <p>
              Today the server covers the <b className="font-medium text-foreground">manager</b>{" "}
              account: your properties, residents, applications, leases, charges, work orders,
              vendors, calendar and messages. Resident and vendor endpoints are not open yet.
            </p>
          </DocSection>

          <DocSection id="keys" kicker="Start here" title="Connect MCP or create an API key">
            <p>
              In the portal, go to{" "}
              <Link
                href="/portal/profile"
                data-attr="mcp-docs-settings-link"
                className="text-primary underline-offset-2 hover:underline"
              >
                Settings &rarr; API &amp; MCP
              </Link>{" "}
              and copy the MCP server URL. Your client opens PropLane in a browser to sign in and approve
              the complete manager assistant connection. Choose <b className="font-medium text-foreground">Create API key</b>
              when you need to grant only the product areas and tools an integration needs:
            </p>
            <DocList>
              <DocLi>
                <Chip>Read</Chip> Look up the selected product area. This is right for reporting,
                dashboards and question-answering.
              </DocLi>
              <DocLi>
                <Chip>Write</Chip> Also proposes changes for that area and includes its read tools.
                Use Advanced tools to choose an exact subset. A write still cannot happen in one step,
                see <a href="#actions" className="text-primary underline-offset-2 hover:underline">Write actions</a>.
              </DocLi>
            </DocList>
            <p>
              The key is shown <b className="font-medium text-foreground">once</b>. PropLane stores
              only a hash of it, so it cannot be recovered or re-displayed. If you lose it, revoke it
              and create another. Revoking takes effect on the next request.
            </p>
          </DocSection>

          <DocSection id="connect" kicker="Start here" title="Connect your agent">
            <p>
              Any client that speaks Streamable HTTP connects directly. Claude Code, Cursor,
              Windsurf and VS Code all take the same server URL. Claude Code can add it with:
            </p>
            <CodeBlock label="terminal">{CLAUDE_CODE_SNIPPET}</CodeBlock>
            <p>On first use, the client follows the secure browser sign-in and consent flow. PropLane never asks you to paste a long-lived API key into an MCP configuration.</p>
            <p>
              Building your own loop, or just checking it works? It is ordinary JSON-RPC over POST:
            </p>
            <CodeBlock label="curl">{CURL_SNIPPET}</CodeBlock>
            <p className="text-[14px]">
              The server implements <Chip>initialize</Chip>, <Chip>tools/list</Chip>,{" "}
              <Chip>tools/call</Chip> and <Chip>ping</Chip>. It is stateless, so there is no session
              header and <Chip>GET</Chip> returns <Chip>405</Chip>. Protocol versions{" "}
              <Chip>2024-11-05</Chip> through <Chip>2025-06-18</Chip> are negotiated; newer clients
              are answered with the latest version supported here.
            </p>
          </DocSection>

          <DocSection id="tools" kicker="Reference" title="Tools">
            <p>
              An MCP connection sees the complete manager catalog after browser authorization. A REST API key sees only its selected
              tools. When either includes write tools, it also receives <Chip>confirm_action</Chip>. Call
              <Chip>tools/list</Chip> for the full JSON Schema of each one; this reference has {counts.read}
              read and {counts.write} write tools and is generated from the live registry.
            </p>
            <ToolTable title="Read" caption="Available when selected in a product area or Advanced tools." tools={readTools} />
            <ToolTable
              title="Actions"
              caption="Available when selected. Each returns a preview and an actionId; nothing changes until you confirm."
              tools={writeTools}
            />
          </DocSection>

          <DocSection id="actions" kicker="Reference" title="Write actions">
            <p>
              Anything that changes data is a two-step. Calling an action tool does not perform it:
              it validates the input, builds a preview of exactly what would happen, and returns an{" "}
              <Chip>actionId</Chip>. A second call to <Chip>confirm_action</Chip> executes it.
            </p>
            <CodeBlock label="propose, then confirm">{ACTION_SNIPPET}</CodeBlock>
            <DocList>
              <DocLi>
                The proposal stores the validated input <b className="font-medium text-foreground">server-side</b>.
                Confirming sends only the id, so nothing between the two steps can alter what runs.
              </DocLi>
              <DocLi>
                A proposal expires after 15 minutes and can be confirmed once. A second confirm gets{" "}
                <Chip>410</Chip>.
              </DocLi>
              <DocLi>
                Show the preview to the person you are acting for before confirming. It is the same
                card the built-in assistant renders, and it is what the audit log records.
              </DocLi>
            </DocList>
            <p>
              Approving a rental application and creating a listing are deliberately{" "}
              <b className="font-medium text-foreground">not</b> available as tools. Both need
              browser-side steps that would otherwise leave a resident without their rent charges.
            </p>
          </DocSection>

          <DocSection id="rest" kicker="Reference" title="REST API">
            <p>
              If you are not using MCP, create a REST API key. Its selected tools are reachable over
              plain HTTP; MCP OAuth tokens are deliberately refused here. The confirmation gate is identical.
            </p>
            <CodeBlock label="HTTP">{REST_SNIPPET}</CodeBlock>
            <p className="text-[14px]">
              A staged write answers <Chip>202</Chip>; a completed call answers <Chip>200</Chip>; a
              refused or invalid call answers <Chip>400</Chip> with an <Chip>error</Chip> string you
              can hand straight back to your model.
            </p>
          </DocSection>

          <DocSection id="limits" kicker="Operating" title="Limits & errors">
            <DocList>
              <DocLi>
                <b className="font-medium text-foreground">120 requests per minute</b> per key, plus
                a lower unauthenticated limit per IP. Over it, <Chip>429</Chip>.
              </DocLi>
              <DocLi>
                <Chip>401</Chip> means the key is missing, unknown, revoked or expired. These are
                deliberately indistinguishable.
              </DocLi>
              <DocLi>
                <Chip>403</Chip> means the key is valid but the account no longer has manager access.
              </DocLi>
              <DocLi>
                A tool that fails returns a normal MCP result with <Chip>isError: true</Chip> and a
                readable message, not a transport error, so your model can correct itself and retry.
              </DocLi>
            </DocList>
          </DocSection>

          <DocSection id="security" kicker="Operating" title="Security">
            <DocList>
              <DocLi>
                <b className="font-medium text-foreground">A key only ever reaches your own data.</b>{" "}
                Every tool derives the account from the authenticated key, never from anything the
                model supplies, so no argument can widen the scope.
              </DocLi>
              <DocLi>
                <b className="font-medium text-foreground">A key is a credential, not a standing
                grant.</b>{" "}
                Your manager role is re-checked on every single request. Lose the role and every key
                stops working with it, immediately.
              </DocLi>
              <DocLi>
                <b className="font-medium text-foreground">Keys are stored hashed.</b> Nobody,
                including PropLane, can read one back after it is created.
              </DocLi>
              <DocLi>
                Treat resident- and applicant-submitted text as untrusted. It reaches your agent as
                data, and it must never be allowed to trigger a confirm on its own.
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
              {firstSentence(tool.description)}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Tool descriptions are written for a model and run long; the table wants the lede. */
function firstSentence(text: string): string {
  const trimmed = text.trim();
  const end = trimmed.search(/\.\s/);
  return end === -1 ? trimmed : trimmed.slice(0, end + 1);
}
