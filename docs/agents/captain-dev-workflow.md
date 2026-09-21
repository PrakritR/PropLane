# Captain development workflow

Prakrit's process and standing authority are defined in
[AGENTS-prakrit.md](AGENTS-prakrit.md). Akhil's process remains separate.

## Plan → approve → build → validate → integrate

Start product and UI work with an editable Lavish prototype in PropLane's
actual design system. Keep the same review session through revisions, verify
its chat round trip, and keep an attached feedback poll running. Build only
after explicit build approval. Follow [the plan standard](lavish-plan-standard.md).

Linear tickets are off unless Prakrit explicitly asks for one. Create the
Lavish artifact independently; do not use a combined helper that creates a
ticket. Instruction maintenance and read-only investigation do not need a
recursive product plan.

## Six standing agent worktrees

| Branch | Worktree directory | Port |
| --- | --- | --- |
| `claude-1` | `proplane-claude` | 3001 |
| `claude-2` | `proplane-claude-2` | 3002 |
| `claude-3` | `proplane-claude-3` | 3003 |
| `cursor-1` | `proplane-cursor-branch-1` | 3004 |
| `cursor-2` | `proplane-cursor-2` | 3005 |
| `codex-1` | `proplane-codex-1` | 3006 |
| `prakrit` | `proplane-prakrit` | 3000 |

The installed path/port registry is Firstmate's
`config/proplane-agent-branches`. Keep the six agents in the existing cockpit
and `prakrit` in its own terminal window. Do not automatically create extra
lanes, dated prompt branches, or delete a standing branch after integration.

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

Commit and push the keeper without force. Open a PR only on request. Prakrit
has authorized completed, validated keeper work to be integrated into
`prakrit`; no repeated integration approval is needed for that bounded step:

```bash
npm run ship:to-prakrit -- --source <keeper>
```

Keep the source branch. Fast-forward clean keepers from the integrated tip,
then verify each completed keeper is an ancestor of `origin/prakrit`.
Report dirty or divergent keepers explicitly instead of claiming all are
synchronized. Do not overwrite another agent's unfinished work.

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
