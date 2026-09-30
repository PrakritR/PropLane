# Captain development workflow

Prakrit's process and standing authority are defined in
[AGENTS-prakrit.md](AGENTS-prakrit.md). Akhil's process remains separate.

## Plan → approve → build → validate → integrate

Start product and UI work with an editable lane plan in the PropLane studio,
mocked in the app's actual design system. Keep the same `plan.html` through
revisions and keep the lane's studio inbox watcher running. Build only once the
plan is buildable. Follow [the plan standard](lavish-plan-standard.md).

Linear tickets are off unless Prakrit explicitly asks for one; when he does, the
ticket id rides on the lane's plan as a label rather than a second call.
Instruction maintenance and read-only investigation do not need a recursive
product plan.

## Six standing agent lanes

The roster itself — lane names, worktree paths, ports — is machine-local config
and is deliberately not copied into this repo (root `AGENTS.md`: "Keeper names
live in local instructions only"); see
[AGENTS-prakrit.md](AGENTS-prakrit.md) § Standing branches, lanes, and the
promote ladder for the sources of truth. Keep the six lanes in the existing
cockpit and `prakrit` in its own terminal window. Do not automatically create
extra lanes, dated prompt branches, or delete a standing lane after
integration.

Each agent works on its own keeper. Before new work, fetch and fast-forward
from `origin/prakrit` when the working tree is clean and the update is a
fast-forward. Preserve unfinished edits and unique commits when it is not.
Temporary isolated worktrees may be used for validation; they are not new
standing lanes and must be retired after their work is preserved.

## Validate before integration

Read the relevant feature architecture notes before editing. For product
changes, seed dev/test data, drive the complete affected browser flow and its
edges, and report actual test/lint exit codes. Follow [the ship gate](../ship-gate.md).

Run security review and no-mistakes before integrating. Review UI changes for
cache/rendering/performance and web/native parity as applicable. Open the
agent's review route with `npm run sandbox:open -- </route>`.

Commit and push the keeper without force. Open a PR only on request. When a
keeper is completed and validated, the **captain** types **`/promote prakrit`**
in that lane's pane to integrate it (runs no-mistakes + security review, merges
to prakrit, fans back to all lanes). Keep the source branch afterward.
Fast-forward clean keepers from the integrated tip, then verify each completed
keeper is an ancestor of `origin/prakrit`. Report dirty or divergent keepers
explicitly instead of claiming all are synchronized. Do not overwrite another
agent's unfinished work.

Before closing an obsolete branch/worktree, preserve its commits and working
copy, distinguish equivalent patches from genuinely missing changes, and
verify integration. Old snapshots are not permission to restore obsolete
behavior over newer reviewed code.

## Release remains separate

Integration stops at `prakrit`. Moving to `main`, staging QA, and production
still require their existing captain/release authorization and checks.
Vercel deploys only `staging` and `production`; production also ships iOS.
See [deployment workflow](deployment-workflow.md) and
[sandbox review](sandbox-open-review.md).

Never mutate production data without explicit authorization for that exact
scope. Locked live listings remain locked. Routine verification uses dev/test.
