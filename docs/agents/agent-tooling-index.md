# Agent tooling index

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

| Command | Purpose |
| --- | --- |
| `npm run linear:ticket -- --chat "…"` | Create a ticket only when explicitly requested |
| `npm run linear:triage` | Explicitly requested backlog maintenance |
| `npm run linear:export -- --ticket PRP-180 --out /tmp/PRP-180.md` | Export a requested ticket to the chosen path |
| `npm run test:unit` | Unit tests |
| `npm run gate:prompt` | Related tests, changed-file lint and full TypeScript |
| `npm run typecheck` | Full-project type generation and TypeScript |
| `npm run sandbox:open -- </route>` | Open the lane's real review route |
| `npm run ship:preflight` | Required production preflight |
| `graphify query "…"` | Optional orientation with a current index |

Promotion uses only the captain commands in [AGENTS-prakrit.md](AGENTS-prakrit.md).

**Env:** `LINEAR_API_KEY` in `.env.local` for Linear scripts. `npm run seed:env` in
new worktrees.

---

## Documentation map (read before edit)

### Workflow & ship

| Doc | When |
| --- | --- |
| `docs/agents/AGENTS-prakrit.md` | Prakrit: lane implementation + validation → captain `/promote` |
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

## Handoff evidence

Use [the UI checklist](ui-change-checklist.md) for visual evidence and
[the ship gate](../ship-gate.md) for tests, schema evidence and release reviews.
Report the scope, verified SHA, real Review URL and remaining limitations.
Read the relevant feature contract before edits; use dev/test data and the
assigned standing lane. No automatic ticket or separate approval artifact.

## Keeping this index current

When you add an MCP server, npm script, or mandatory agent doc — update this file
and `.cursor/mcp.json` in the same change.
