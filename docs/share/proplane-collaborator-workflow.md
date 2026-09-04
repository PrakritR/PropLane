# PropLane — how we ship work (share this with collaborators)

PropLane uses a **fixed pipeline** so nothing gets built without a ticket and a
reviewed plan. This doc is for anyone joining the team (engineers, designers, QA).

**Linear team:** [PropLane (PRP-)](https://linear.app/axishousing) on axishousing workspace.

---

## The five phases (always in order)

```
① TICKET  →  ② PLAN (Lavish)  →  ③ BUILD  →  ④ REVIEW  →  ⑤ PROMOTE
```

| Phase | What happens | Who approves |
| --- | --- | --- |
| **① Ticket** | Work is filed in Linear with project, milestone, labels, assignee, priority | Auto-routed (comms → Akhil; else → Prakrit) |
| **② Plan** | Agent writes a **Lavish** HTML plan; you review in the browser | **You** — say `approved — build` |
| **③ Build** | Code on an agent sandbox branch (`cursor-1`, `cursor-2`, `claude-1`, …) | — |
| **④ Review** | Happy path + edge cases on localhost sandbox port | **You** — request changes or approve promote |
| **⑤ Promote** | Merge sandbox → `prakrit` (integration at localhost:3000) | **You** — explicit “merge to prakrit” |

**Hotfix only:** you may say `no ticket` or `skip plan` — otherwise agents must not skip ① or ②.

---

## Assignments & priority (automatic)

| Rule | Value |
| --- | --- |
| **Communication Hub** (SMS, inbox, email, messaging) | **Akhil** |
| Everything else | **Prakrit (M)** |
| **High priority** | Breaks signup/login/apply/pay/messaging; wrong charges; unusable UI |
| **Medium** | Properties, residents, payments, listings, calendar — daily use; annoying but completable |
| **Low** | Cosmetic UI, copy, contrast audit, rename, dev tooling — **not** “looks off” alone |

**UI rule:** polish and layout tweaks are **Low** unless the user cannot finish the task.

**Backlog sort (Linear view):** Project (category) → Priority → Assignee. Pull Todo in that order.

Re-run triage anytime: `npm run linear:triage` (needs `LINEAR_API_KEY` in `.env.local`).
Full rules: `docs/linear-ticket-system.md` → **Priority & backlog sort**.

---

## One-time machine setup

### 1. Linear API key (required — no MCP for tickets)

1. Open https://linear.app/settings/api → create a personal API key.
2. Add to repo `.env.local` (never commit):

```bash
LINEAR_API_KEY=lin_api_xxxxxxxx
```

### 2. Lavish (plan review UI)

```bash
# Open any plan HTML in the browser (annotations + feedback)
npx -y lavish-axi .lavish/plans/PRP-###-slug/plan.html

# Poll for captain feedback while you work elsewhere
npx -y lavish-axi poll .lavish/plans/PRP-###-slug/plan.html
```

Plans live under `.lavish/plans/` (gitignored — may contain screenshots).

### 3. Cursor MCP (execution & QA only)

Checked in: `.cursor/mcp.json`

| MCP | Use for |
| --- | --- |
| **playwright** | Browser automation on localhost:3000–3014 |
| **browser-use** | Manual QA walkthroughs, screenshots |
| **chrome-devtools** | Debug layout / network in Chrome |
| **supabase** | Dev DB queries (`emstjswhotsnyksqhqyf` only) |
| ~~linear~~ | **Do not use for tickets** — use `LINEAR_API_KEY` + npm scripts |

Enable in **Cursor → Settings → Tools & MCP**. Authenticate Supabase when prompted.

### 4. Agent sandboxes

| Agent | Branch | Local URL |
| --- | --- | --- |
| Cursor 1 (resident) | `cursor-1` | http://localhost:3010 |
| Cursor 2 (manager) | `cursor-2` | http://localhost:3011 |
| Claude 1 (comms) | `claude-1` | http://localhost:3012 |
| Integration | `prakrit` | http://localhost:3000 |

After promote, **all sandboxes reset** to match `prakrit`.

---

## Day-to-day commands

### Start work from an idea (ticket + plan in one step)

```bash
npm run workflow:plan -- --chat "Manager calendar bookings panel needs a revamp"
```

This will:

1. Create **PRP-###** in Linear (auto project, labels, assignee, priority)
2. Scaffold **Lavish** `plan.html` and open it
3. Link the plan on the Linear ticket
4. **Stop** — waiting for your approval

### Or: ticket only, then plan

```bash
npm run linear:ticket -- --chat "Residents tab crashes when I open Payments"
npm run workflow:plan -- --ticket PRP-### --title "..." --summary "..."
```

### After you approve the plan

Reply in chat or Linear: **`approved — build`**

Agent then codes on the sandbox branch, tests on the sandbox port, and hands off for review.

### When review looks good

Say: **`merge to prakrit`**

---

## UI changes (extra reading)

Portal UI must follow the **Properties tab** pattern. Before editing UI:

1. Read **`docs/portal-ui-system.md`**
2. Read **`docs/agents/ui-change-checklist.md`**
3. Use shared components (`PortalRecordListSurface`, `portal-record-row`, etc.) — no bespoke list layouts

---

## Production safety

- **Never** write production data (residents, properties, leases, charges, messages).
- Dev/test Supabase only unless you issue a **named one-shot waiver** in writing.
- Live listing rows for Brooklyn / 4709A are captain-gated — see `no-production-live-listings` rule.

---

## Where to learn more

| Doc | Purpose |
| --- | --- |
| `docs/linear-ticket-system.md` | Ticket folders, labels, routing tree |
| `docs/agents/captain-dev-workflow.md` | Full agent pipeline |
| `docs/cursor-mcp-setup.md` | MCP install & troubleshooting |
| `docs/portal-ui-system.md` | Portal UI patterns |
| `docs/observability.md` | PostHog + Langfuse |

---

## Quick chat phrases

| You say | Agent does |
| --- | --- |
| Describe a bug or feature | ① Ticket → ② Lavish plan |
| `approved — build` | ③ Implement |
| `merge to prakrit` | ⑤ Promote to integration |
| `no ticket` / `skip plan` | Skip that phase (hotfix) |

Questions? Comment on the **PRP-###** ticket or annotate the Lavish plan.
