# Captain dev workflow (PropPlane)

**Default pipeline for every agent pane.** The captain reviews plans in **Lavish**
before any build. Share a **Linear markdown snapshot** with friends/reviewers
before or alongside the Lavish plan.

## The three gates (always in order)

```
① TICKET  →  ② PLAN + SHARE  →  ③ EXECUTE  →  ④ REVIEW  →  ⑤ PROMOTE
```

| Phase | Agent does | Captain does |
| --- | --- | --- |
| **① Ticket** | File Linear issue from chat | Skim **PRP-###** in Linear |
| **② Plan + share** | Lavish `plan.html` + `ticket.md` export | Review Lavish; send `ticket.md` to friend if needed |
| **③ Execute** | Build on keeper branch; wire MCP/tools | — |
| **④ Review** | Test sandbox port; summarize | Review localhost + diff |
| **⑤ Promote** | Merge to `prakrit` when captain asks | Approve integration; verify :3000 |

**Do not skip ① or ②** unless the captain says **"no ticket"** or **"skip plan"**
(hotfix only).

**Visual workflow board:** `docs/lavish/captain-workflow.html` — open with
`npx -y lavish-axi docs/lavish/captain-workflow.html`.

---

## ① Ticket first (Linear)

**Rule:** If the captain describes work, a bug, an idea, or pastes feedback —
**create a ticket before anything else**, even when they did not ask.

```bash
npm run linear:ticket -- --chat "<captain message>"
```

- Reply with **PRP-###** + full Linear URL.
- Routing: `docs/linear-ticket-system.md` + `scripts/linear/ticket-routing.mjs`.
- The CLI prints **next-step commands** for plan + export after create.

**MCP (optional):** Linear is in `.cursor/mcp.json` for read/update in Cursor.
Filing still uses `npm run linear:ticket` (API key in `.env.local`) so scripts
work in CI and every agent host.

---

## ② Plan in Lavish + shareable Markdown

**No product code until the captain approves the plan.**

### 2a — Export ticket snapshot (share with friend)

```bash
npm run linear:export -- --ticket PRP-### \
  --out .lavish/plans/PRP-###-short-slug/ticket.md
```

- One folder per ticket: `.lavish/plans/PRP-###-slug/` holds **`ticket.md`** +
  **`plan.html`** + **`assets/`**.
- Email or Slack `ticket.md` to a friend; they do not need the repo.
- Re-export after you edit the Linear description.

### 2b — Lavish implementation plan

```bash
npx -y lavish-axi playbook plan    # read before writing HTML
npm run lavish:plan -- --ticket PRP-### --title "..." --summary "..." \
  --image /path/to/cursor-attachment.png --open
```

1. **Images:** every captain attachment → `--image` (copied to `assets/`).
2. Open: `npx -y lavish-axi .lavish/plans/PRP-###-slug/plan.html`
3. Poll: `npx -y lavish-axi poll <plan.html>` (background OK).
4. Apply annotations; reply with `--agent-reply "…"`.
5. **Optional public share:** `npx -y lavish-axi share <plan.html>` → ht-ml.app URL.
6. **Stop** until captain says **approved — build**.

Embed in `plan.html`: link to `ticket.md` and Linear URL. Update Linear description
with plan folder path when stable.

### ② Done when

- [ ] `ticket.md` exported in plan folder
- [ ] `plan.html` reviewed in Lavish (captain or friend)
- [ ] Captain said **approved — build**

---

## ③ Execute (build + tooling)

### Branch

| Pane | Keeper branch | Sandbox URL |
| --- | --- | --- |
| Cursor 1 | `cursor-1` | http://localhost:3010 |
| Cursor 2 | `cursor-2` | http://localhost:3011 |
| Claude 1 | `claude-1` | http://localhost:3012 |

Commit and push **only** the pane's keeper branch. Experiments:
`scripts/proplane-test-branch.sh start <slug>`.

### Before touching code

| Area | Read first |
| --- | --- |
| Any portal UI | `docs/portal-ui-system.md` |
| Feature invariants | `docs/agents/<area>.md` |
| Tooling / MCP | `docs/agents/agent-tooling-index.md` |
| Architecture grep | `graphify query "…"` |

### MCP & tools (connect once per machine)

See **`docs/agents/agent-tooling-index.md`**. Checked-in: `.cursor/mcp.json`
(Linear, Supabase dev, Playwright, Chrome DevTools, browser-use).

### Execute checklist

- [ ] Reference **PRP-###** in commits
- [ ] Read `docs/agents/<area>.md` for the subsystem
- [ ] Unit tests for behavior you add
- [ ] Manual happy path on sandbox port (not `/demo` alone)
- [ ] security-review + bugbot before handoff (`ship-and-review-gate`)

---

## ④ Review (sandbox)

1. Dev server on **this pane's port** (see table above).
2. Happy path + edge cases (`docs/ship-gate.md`).
3. `npm run test:unit` (targeted); smoke e2e when UI/routes changed.
4. Linear comment: what was tested, PRP link, localhost URL.
5. Tell captain: ready on **keeper branch** (not `prakrit` yet).

---

## ⑤ Promote (captain gate)

```bash
bin/fm-proplane-promote-to-prakrit.sh <keeper-branch>
```

Merges into `prakrit` and resets all agent sandboxes from `origin/prakrit`.
Captain verifies **http://localhost:3000**. Later: `main` → Vercel Preview →
`production` when ready.

---

## Chat triggers

| Captain says | Phase |
| --- | --- |
| Work / bug / idea | ① Ticket |
| After ticket | ② Export + Lavish plan |
| "approved — build" / "LGTM build" | ③ Execute |
| "merge to prakrit" / "promote" | ⑤ Promote |
| "no ticket" / "skip plan" | Skip that gate only |

---

## Artifacts

| What | Path |
| --- | --- |
| Workflow board (Lavish) | `docs/lavish/captain-workflow.html` |
| Per-ticket folder | `.lavish/plans/PRP-###-slug/` |
| Standalone ticket export | `.lavish/tickets/PRP-###.md` |
| Cursor rules | `.cursor/rules/captain-dev-workflow.mdc` |
| Linear folders | `docs/linear-ticket-system.md` |
| MCP + docs index | `docs/agents/agent-tooling-index.md` |
| Plan scaffold | `npm run lavish:plan` |
| Ticket export | `npm run linear:export` |

---

## Production data (hard stop)

**Never write production data.** Dev/test Supabase only unless the captain issues a
**named one-shot waiver**. See `no-production-data-writes.mdc` and
`no-production-live-listings.mdc`.
