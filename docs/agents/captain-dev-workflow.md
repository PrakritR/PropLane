# Captain dev workflow (PropPlane)

**Default pipeline for every agent pane.** The captain reviews plans in **Lavish**
before any build. Share **`ticket.md`** with friends via
`docs/share/proplane-collaborator-workflow.md`.

## The three gates (always in order)

```
① TICKET  →  ② PLAN + SHARE  →  ③ EXECUTE  →  ④ REVIEW  →  ⑤ PROMOTE
```

| Phase | Agent does | Captain does |
| --- | --- | --- |
| **① Ticket** | File Linear issue from chat | Skim **PRP-###** in Linear |
| **② Plan + share** | Lavish `plan.html` + optional `ticket.md` | Review Lavish; share `ticket.md` if needed |
| **③ Execute** | Build on keeper branch; wire MCP/tools | — |
| **④ Review** | Test sandbox port; summarize | Review localhost + diff |
| **⑤ Promote** | Push keeper branch; captain runs `ship:to-prakrit` + main ladder | Approve integration; verify :3000 on review route |

**Do not skip ① or ②** unless the captain says **"no ticket"** or **"skip plan"**
(hotfix only).

**Visual workflow board:** `npm run lavish:workflow`

---

## ① + ② Ticket and plan (preferred one-shot)

```bash
npm run workflow:plan -- --chat "<captain message>"
```

Creates **PRP-###**, scaffolds `.lavish/plans/PRP-###-slug/plan.html`, links the
plan on the Linear ticket, opens Lavish. **No product code** until approval.

**Existing ticket:**

```bash
npm run workflow:plan -- --ticket PRP-### --title "..." --summary "..." --image /path.png
```

**Ticket only** (plan later): `npm run linear:ticket -- --chat "…"`

**Priority when filing** (auto unless you pass `--priority 1-4`):

| Level | Use when |
| --- | --- |
| **High** | Blocks signup → listing → apply → pay; wrong charges; unusable UI |
| **Medium** | Frequent portal surface; confusing but completable |
| **Low** | Cosmetic UI, copy, rename, dev tooling |

UI polish is **Low** unless the screen is unusable. Full matrix + backlog sort order:
`docs/linear-ticket-system.md` → **Priority & backlog sort**. Normalize open issues:
`npm run linear:triage`.

Manual enrich + poll:

1. `npx -y lavish-axi playbook plan` (and `comparison` / `diagram` if needed).
2. **Images:** `--image` on `workflow:plan` or `lavish:plan` (stored in `assets/`).
3. `npm run lavish:poll` — **mandatory** on every agent turn while `.lavish/active-session.json` exists.
4. **Stop** until captain says **approved — build**.

### Share with a friend

```bash
npm run linear:export -- --ticket PRP-### \
  --out .lavish/plans/PRP-###-slug/ticket.md
```

Email or Slack `ticket.md`; optional Lavish public URL:

```bash
npx -y lavish-axi share .lavish/plans/PRP-###-slug/plan.html
```

Full collaborator guide: **`docs/share/proplane-collaborator-workflow.md`**.

### ② Done when

- [ ] `plan.html` reviewed in Lavish
- [ ] `ticket.md` exported if sharing async
- [ ] Captain said **approved — build**

---

## ③ Execute (build + tooling)

| Pane | Keeper branch | Sandbox URL |
| --- | --- | --- |
| Cursor 1 | `cursor-1` | http://localhost:3010 |
| Cursor 2 | `cursor-2` | http://localhost:3011 |
| Claude 1 | `claude-1` | http://localhost:3012 |

Commit and push **only** the pane's keeper branch.

| Area | Read first |
| --- | --- |
| Portal UI | `docs/portal-ui-system.md` + `docs/agents/ui-change-checklist.md` |
| Feature | `docs/agents/<area>.md` |
| MCP / tools | `docs/agents/agent-tooling-index.md` |
| Code map | `graphify query "…"` |

---

## ④ Review (sandbox)

1. Dev server on **this pane's port**.
2. **`npm run sandbox:open -- </route>`** — mandatory before handoff; opens browser + records `.proplane-review-path` (`docs/agents/sandbox-open-review.md`).
3. Happy path + edge cases (`docs/ship-gate.md`).
4. Targeted `npm run test:unit`; smoke e2e when UI/routes changed.
5. Linear comment: what was tested, PRP link, full Review URL.

**Captain promote (not agents):** `npm run ship:to-prakrit -- --source <keeper>` runs security review + no-mistakes, then opens `localhost:3000` on the review route.

---

## ⑤ Promote (captain gate)

Land the keeper branch on `main` (captain). Then:

```bash
npm run ship:staging      # ff main → staging; dedicated QA tests that URL
npm run ship:production   # ff staging → production after QA sign-off
```

Or use the GitHub Action **Promote** (`workflow_dispatch`). Do not use
`bin/fm-proplane-promote-to-prakrit.sh` — `prakrit` is retired.

Captain verifies the `main` Preview (developers) and the `staging` URL (QA)
before a live ship.

---

## Artifacts

| What | Path / command |
| --- | --- |
| Workflow board | `docs/lavish/captain-workflow.html` → `npm run lavish:workflow` |
| Per-ticket folder | `.lavish/plans/PRP-###-slug/` (`plan.html`, `ticket.md`, `assets/`) |
| One-shot ticket+plan | `npm run workflow:plan` |
| Ticket export | `npm run linear:export` |
| Collaborator guide | `docs/share/proplane-collaborator-workflow.md` |
| MCP index | `docs/agents/agent-tooling-index.md` |
| Linear folders | `docs/linear-ticket-system.md` |

---

## Production data (hard stop)

**Never write production data.** Dev/test Supabase only unless the captain issues a
**named one-shot waiver**. See `no-production-data-writes.mdc` and
`no-production-live-listings.mdc`.
