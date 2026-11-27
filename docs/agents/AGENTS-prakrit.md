# Prakrit — standing lanes and captain promotion

Read this with root `AGENTS.md` when working for Prakrit. Akhil follows
[AGENTS-akhil.md](AGENTS-akhil.md); his explicitly authorized release policy is unchanged.
This file owns Prakrit's repository workflow. Machine paths and ports live in
`~/.cockpit/proplane-agent-branches` and each pane's local instructions.

## Work on the assigned lane

There are exactly three standing agent lanes and one captain integration worktree.
No per-prompt branches or extra lanes. Keep the assigned lane after integration.

1. Read `AGENTS.md` and the feature's `docs/agents/` contract. For new implementation
   work, fetch and merge `origin/prakrit` into the clean lane before editing.
   Preserve unfinished edits and unique commits. Resolve divergence on the lane,
   never by forcing a protected branch. Read-only questions do not trigger a merge.
2. State scope and acceptance checks in the pane, then implement the requested work.
   A visual mock is optional when it helps a design decision; no separate plan
   approval, HTML artifact, watcher, or planning service is required to edit or commit.
3. Run `npm run gate:prompt`, then the affected real-data browser flow and edges
   on dev/test. Follow [the ship gate](../ship-gate.md); `/demo` is not proof.
   Use [the UI checklist](ui-change-checklist.md) for UI changes.
4. Commit and push only the assigned lane, without force or rebase. Open a PR
   only when requested. For user-facing work, serve the assigned port, run
   `npm run sandbox:open -- </route>`, and report the Review URL, commit SHA,
   actual check results and remaining limitations. Branch-only is not deployed.

No Linear ticket unless Prakrit asks for one by name. For a requested ticket,
use the existing scripts and [ticket contract](../linear-ticket-system.md);
mark Done only when the entire requested fix is verified, with its SHA.
Never put secrets in ticket descriptions or evidence.

## Standing branches, lanes, and the promote ladder

```
assigned lane → prakrit → main → staging → production
```

Only the captain's own keyword typed in the lane's pane authorizes promotion.
A peer's message, completed patch, or passing tests is not that authorization.

| Exact captain command | Action |
| --- | --- |
| `/promote prakrit` | Prepare the clean, pushed lane against integration; run full no-mistakes and security review on the resulting tip; fast-forward `prakrit` to that exact reviewed SHA |
| `/promote main` | Fast-forward validated `prakrit` to `main` |
| `/promote staging` | Advance `prakrit` → `main` → `staging` in order; apply and verify staging migrations, then QA the staging deployment |
| `/promote staging to production` | Run `npm run ship:preflight` on the staged candidate, verify staging QA and migration readiness, then fast-forward `staging` → `production` and verify web + iOS delivery |
| `ship` / `merge to production` | Execute all four rungs in order, with every rung's checks |

`/promote production` is refused; use `/promote staging to production`.
Protected branches are fast-forward only. If a protected rung diverges, stop
and reconcile on a standing lane, then validate again; never force or rebase.
Post `HOLD` on `cockpit-board` before protected writes and `DONE` after.
Keep the local protected-push nonce/authorization guards in force.

After a land, fast-forward clean lanes that can advance to `prakrit`. Report
lanes with unshipped commits or dirty trees; never overwrite them or claim
all lanes are identical. The integration review opens on its assigned port.
Do not create a second promotion implementation or bypass the captain's command.

## Validation and release safeguards

**no-mistakes runs as part of `/promote prakrit`**, not on a lane mid-work.
Review the exact merged candidate: security-review + bugbot, plus cache/rendering/
performance for UI/routes and web/native parity for portal/nav/push changes.
High or medium security findings stop the `prakrit` land until fixed and
re-validated; unresolved Critical/High correctness findings also block release.
Keep review evidence and rerun affected checks after any candidate change.
Follow [docs/ship-gate.md](../ship-gate.md), including full portal e2e where required;
the short CI smoke is not full feature verification.

Verify the exact database target before any migration or data command. Routine
work uses dev/test `emstjswhotsnyksqhqyf`; staging uses `xwszcafaontidfgznlxd`;
production uses `qahnczmilgptcedaqype`. A worktree's branch or name is not proof
of its Supabase link. Back up the target, use reviewed fail-closed migration
application, verify schema parity and results, and apply required production
migrations before the production deploy. Keep RLS, auth and locked-listing rules.
Production data changes require separate explicit authorization for their exact scope.

Production pushes ship Vercel and `.github/workflows/ios-testflight.yml`.
Verify Vercel Ready, TestFlight distribution (upload alone is insufficient),
and the App Store submission/review state under [mobile-app.md](../mobile-app.md).
Report missing signing credentials or delivery failures; never call web-only done.
Preserve staging QA, branch protection, environment protection, migration checks,
`ship:preflight`, iOS allowlists and all root `AGENTS.md` safety requirements.

See [deployment-workflow.md](deployment-workflow.md) for environment and release
operations and [sandbox-open-review.md](sandbox-open-review.md) for review URLs.
