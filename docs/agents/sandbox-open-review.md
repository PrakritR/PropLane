# Sandbox open review (all agents)

After any **user-facing fix**, open the captain's browser to the exact route
where they can verify it — do not hand off with only "refresh localhost."

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
2. **Before** telling the captain the work is ready.
3. Include the full **Review URL** in your handoff (the script prints it).

Options:

- `npm run sandbox:open -- --print /portal/tasks` — print URL only
- `npm run sandbox:open -- --port 3011 /portal/tasks` — override port

Port resolution: `--port` → `PROPPLANE_SANDBOX_PORT` → `.env.local`
`NEXT_PUBLIC_APP_URL` → optional gitignored `.cursor/rules/local-agent-branch.mdc`
(per-pane, may be absent) → `3010`.

## Promote sandbox → prakrit (captain / firstmate only)

Agents land on their keeper branch only. After captain approves, integration runs
**security review + no-mistakes** before pushing `prakrit`:

```bash
npm run ship:to-prakrit -- --source cursor-1
# optional override:
npm run ship:to-prakrit -- --source cursor-1 --path /portal/tasks
```

Then opens `http://localhost:3000` on the review route (from `.proplane-review-path`
or `--path`). Next ladder step (also no-mistakes):

```bash
bin/fm-proplane-promote-prakrit-to-main.sh --push-main
```

`npm run ship:integrate` merges to `main` **without** no-mistakes — prefer the
prakrit ladder above when the captain wants gated promotion.

## Firstmate / multi-pane

```bash
bin/fm-proplane-open-localhost.sh --open-browser
bin/fm-proplane-open-localhost.sh --open-browser --path /portal/tasks
bin/fm-proplane-promote-to-prakrit.sh cursor-1 --path /portal/tasks
```

## Rule file

`.cursor/rules/sandbox-open-feature-review.mdc` — always applied in this repo.
