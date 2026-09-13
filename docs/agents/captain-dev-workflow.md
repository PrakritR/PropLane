# Captain dev workflow (PropPlane)

**Prakrit's pipeline.** Short copy for agents: [`AGENTS-prakrit.md`](AGENTS-prakrit.md).
Akhil's agents skip this unless he asks: [`AGENTS-akhil.md`](AGENTS-akhil.md).

The captain reviews plans in **Lavish** before any build. Linear tickets are
off by default; create one only when Prakrit explicitly asks for it.

## The three gates (always in order)

```
① LAVISH PLAN  →  ② ITERATE  →  ③ EXECUTE  →  ④ REVIEW  →  ⑤ PROMOTE
```

| Phase | Agent does | Captain does |
| --- | --- | --- |
| **① Plan** | Create a standalone Lavish `plan.html` | Review the interactive plan |
| **② Iterate** | Apply feedback to the same artifact and session | Annotate, chat, and explicitly approve build when ready |
| **③ Execute** | Build on keeper branch; wire MCP/tools | — |
| **④ Review** | Test sandbox port; summarize | Review localhost + diff |
| **⑤ Promote** | Push keeper branch; captain runs `ship:to-prakrit` + main ladder | Approve integration; verify :3000 on review route |

**Do not skip ① or ②** unless the captain explicitly says **"skip plan"** or
**"just do it"** for that task. A ticket is not part of the default path.

**Visual workflow board:** `npm run lavish:workflow`

---

## ① + ② Standalone plan and review

```bash
npm run lavish:plan -- --title "<task>" --summary "<captain request>"
```

This scaffolds `.lavish/plans/PLAN-…/plan.html` without a ticket. Fill the
scaffold, open the real Lavish review session, and attach the feedback poll.
**No product code** until explicit approval.

**When Prakrit explicitly names an existing ticket:**

```bash
npm run lavish:plan -- --id PRP-### --title "..." --summary "..." --image /path.png
```

Create a new ticket only when Prakrit explicitly requests it.

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
2. **Images:** `--image` on `lavish:plan` (stored in `assets/`).
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
5. Report commit SHA, tests, and Review URL in the handoff. Update Linear only
   when Prakrit pointed this work at an existing ticket.

```bash
npm run linear:comment -- --ticket PRP-### --sha <commit> --lane <keeper>
```

**Captain promote (not agents):** `npm run ship:to-prakrit -- --source <keeper>` runs security review + no-mistakes, then opens `localhost:3000` on the review route.

---

## ⑤ Promote (captain gate)

Fold the keeper into **`prakrit`** (integration across all agent branches), then
`main`, then the deploy rungs:

```bash
npm run ship:to-prakrit -- --source <keeper>   # security review + no-mistakes → prakrit
# or: /promote prakrit
# then: bin/fm-proplane-promote-prakrit-to-main.sh --push-main
npm run ship:staging      # ff main → staging; dedicated QA tests that URL
npm run ship:production   # ff staging → production after QA sign-off
```

Or use the GitHub Action **Promote** (`workflow_dispatch`) for staging/production.

Captain verifies `prakrit` / `main` on localhost (developers) and the `staging`
URL (QA) before a live ship.

---

## Artifacts

| What | Path / command |
| --- | --- |
| Workflow board | `docs/lavish/captain-workflow.html` → `npm run lavish:workflow` |
| Plan folder | `.lavish/plans/PLAN-…-slug/` (`plan.html`, `assets/`) |
| Standalone plan | `npm run lavish:plan` |
| Existing ticket export, when requested | `npm run linear:export` |
| Collaborator guide | `docs/share/proplane-collaborator-workflow.md` |
| MCP index | `docs/agents/agent-tooling-index.md` |
| Linear folders | `docs/linear-ticket-system.md` |

---

## Production data

Default routine work to dev/test Supabase. A production schema or data change
requires explicit authorization for its exact scope, a reviewed and backed-up
fail-closed apply path, and post-apply verification. Authorization does not
extend to unrelated mutations. The separate locked-listing constraints in
`no-production-live-listings.mdc` still apply.
