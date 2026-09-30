# Agent tooling index (MCP, docs, studio plans)

One-page map for execution — what to connect, what to read, when to use
which tool. Captain workflow phases: **`docs/agents/captain-dev-workflow.md`**.

---

## MCP servers (`.cursor/mcp.json`)

Enable in **Cursor → Settings → Tools & MCP**. OAuth on first use unless noted.

| Server | Use when | Notes |
| --- | --- | --- |
| **linear** | Read ticket context when requested | No new tickets unless Prakrit explicitly asks. [Setup](../cursor-linear-mcp.md) |
| **supabase** | Schema introspection, dev DB queries | Project ref = **dev/test only** (`emstjswhotsnyksqhqyf`). Never production. |
| **playwright** | Browser automation against localhost | Allowed origins include :3000, :3010, :3011, prop-lane.space |
| **chrome-devtools** | Live page debug, network, a11y tree | `--autoConnect` to local Chrome |
| **browser-use** | Interactive QA, screenshots, captain walkthroughs | Requires Chrome remote debugging |

**PostHog / Stripe plugins:** authenticate in MCP panel when doing analytics or
payments work — optional, not required for every task.

**Rule:** MCP is for **read/explore/verify**. Writes to product data still go through
app routes and agent tools, not ad-hoc SQL on production.

---

## CLI scripts (no MCP required)

| Command | Phase | Purpose |
| --- | --- | --- |
| `npm run linear:ticket -- --chat "…"` | Explicit request only | Create the ticket Prakrit asked for |
| `npm run linear:triage` | Explicit request only | Re-apply assignee + priority on open backlog |
| `npm run linear:export -- --ticket PRP-###` | ② | Shareable `ticket.md` |
| `studio-plan.mjs new --lane <lane> --id <id> --title "…"` | ② | Scaffold the lane's `plan.html` |
| `studio-inbox.mjs --lane <lane> --wait` | ② | Watch for captain feedback |
| `studio-plan.mjs status --lane <lane>` | ② | Exits 0 once the plan is buildable |
| `npm run test:unit` | ③④ | Unit tests |
| `npm run gate:prompt` | ③④ | Per-prompt gate: vitest + eslint on the changed files, then `tsc` |
| `npm run typecheck` | ③④ | `tsc --noEmit` on the whole project |
| `npm run ship:preflight` | ⑤ | Pre-promote checks |
| `graphify query "…"` | ③ | Codebase orientation before grep |

The `studio-*.mjs` tools live in `~/proplane-mock-kit/tools/` (outside this
repo); run them with `node`. Contract: [`lavish-plan-standard.md`](lavish-plan-standard.md).

**Env:** `LINEAR_API_KEY` in `.env.local` for Linear scripts. `npm run seed:env` in
new worktrees.

---

## Documentation map (read before edit)

### Workflow & ship

| Doc | When |
| --- | --- |
| `docs/agents/AGENTS-prakrit.md` | Prakrit: studio plan → approved → build + `gate:prompt` → `/promote` |
| `docs/agents/AGENTS-akhil.md` | Akhil: working style; no ticket/plan unless asked |
| `docs/agents/captain-dev-workflow.md` | Full Prakrit pipeline |
| `docs/linear-ticket-system.md` | Filing, labels, project folders, **priority & backlog sort** |
| `docs/ship-gate.md` | Before promote / non-trivial finish |
| `docs/agents/deployment-workflow.md` | `main` → `staging` → `production` |

### UI (read before portal changes)

| Doc | When |
| --- | --- |
| **`docs/portal-ui-system.md`** | **Any** manager/resident/vendor/admin UI |
| `docs/portal-list-section-layout.md` | Title band, mobile duplicate controls |
| `docs/web-and-native-parity.md` | Nav, routes, push, Capacitor |

### Feature invariants (`docs/agents/`)

Read the file for the area you touch — full list in `AGENTS.md` feature table.
Examples: `communication-inbox.md`, `resident-payments.md`, `lease-generation.md`,
`ai-assistant.md`, `plan-entitlements.md`.

### AI agent

| Doc | When |
| --- | --- |
| `docs/ai-assistant.md` | Tools, write gates, new capabilities |
| `docs/observability.md` | Langfuse + PostHog instrumentation |

---

## Writing the plan body (phase ②)

The plan bar — five tabs, before/after, semi-interactive, decision forms — is
owned by [`lavish-plan-standard.md`](lavish-plan-standard.md), and the extra
evidence sections by [`plan-evidence.md`](plan-evidence.md). Match PropLane
visual language when mocking UI — copy from real components
(`docs/agents/marketing-mocks.md`).

---

## Subagent brief snippet

Paste into security-review, bugbot, explore:

> An approved studio lane plan is required before product changes. No
> Linear ticket unless Prakrit asks for one.
> Dev/test data only. Read `docs/agents/<area>.md` + `docs/portal-ui-system.md`
> for UI. Use the assigned standing lane and never push a protected branch —
> `prakrit` is reached only by the captain typing `/promote prakrit`, and the
> lane is kept afterward (AGENTS-prakrit.md).

---

## Keeping this index current

When you add an MCP server, npm script, or mandatory agent doc — update this file
and `.cursor/mcp.json` in the same change.
