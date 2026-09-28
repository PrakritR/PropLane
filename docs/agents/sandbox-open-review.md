# Sandbox open review (all agents)

After any **user-facing fix**, open the developer's browser to the exact route
where they can verify it - do not hand off with only "refresh localhost."

## Command (mandatory before handoff)

```bash
npm run sandbox:open -- </route>
```

Examples:

| Area fixed | Open |
| --- | --- |
| Manager Tasks settings | `/portal/tasks` (then **Settings**) |
| Manager Properties | `/portal/properties` |
| Resident Payments | `/resident/payments` |
| Public browse | `/rent/browse` |

Pick the **shortest path** that shows the changed UI. If a modal is required,
open the parent section and say which control to click (until a deep link exists).

The script also writes **`.proplane-review-path`** (gitignored) so promotion can
reopen the same route on integration localhost.

## When to run

1. **After** the fix is saved and the dev server on this pane's port is up.
2. **Before** telling the developer the work is ready.
3. Include the full **Review URL** in your handoff (the script prints it).

Options:

- `npm run sandbox:open -- --print /portal/tasks` — print URL only
- `npm run sandbox:open -- --port 3011 /portal/tasks` — override port

Port resolution: `--port` → `PROPPLANE_SANDBOX_PORT` → `.env.local`
`NEXT_PUBLIC_APP_URL` → optional gitignored `.cursor/rules/local-agent-branch.mdc`
(per-pane, may be absent) → `3010`.

## Prakrit promotion: sandbox → prakrit

Agents build on standing keeper branches. When ready, **the captain** types
**`/promote prakrit`** in the lane's own pane. That command syncs the lane,
runs the full no-mistakes pipeline, and merges to prakrit. Keep the keeper
afterward. The ladder continues with captain-typed **`/promote main`** →
**`/promote staging`** → **`/promote staging to production`**. See
[`AGENTS-prakrit.md`](AGENTS-prakrit.md) § Standing branches, lanes, and the
promote ladder.

Akhil's process defaults to the same keeper handoff. Only an explicit Akhil ship
request authorizes agents working for him to promote his reviewed keeper →
`main` → `staging` → `production`. They do not write `prakrit`, run
no-mistakes, or waive staging and production safety.

## Firstmate / multi-pane

```bash
bin/fm-proplane-open-localhost.sh --open-browser
bin/fm-proplane-open-localhost.sh --open-browser --path /portal/tasks
bin/fm-proplane-promote-to-prakrit.sh cursor-1 --path /portal/tasks
```

## Rule file

`.cursor/rules/sandbox-open-feature-review.mdc` — always applied in this repo.
