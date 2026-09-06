# Release gate reconciliation — 2026-09-05

The release-path restoration replaces the unavailable
`bin/fm-proplane-security-review.sh` instruction in `docs/ship-gate.md` with the
document's existing mandatory `security-review` and `bugbot` branch-change
reviews. Dated reports must identify the reviewed revision/diff, findings,
severity and resolution evidence; affected changes require re-review after fixes.
Unresolved Critical or High findings still block landing. The no-mistakes and
unit-test checks remain required.

## Evidence for the dangling reference

- The command entered `docs/ship-gate.md` in commit
  `89f14b379ca42565ab8857ce229bfb35b8e37dfe` (2026-07-28), a documentation-only
  change describing the now-retired `prakrit` promotion pipeline. No `bin/`
  implementation accompanied it.
- `git log --all -- bin/fm-proplane-security-review.sh` returned no history.
  A filename search over `git rev-list --objects --all` found no matching wrapper
  anywhere in reachable history.
- Filename searches found no `fm-proplane*.sh` in the available repository
  checkouts/worktrees, temporary workspaces, local bin/config directories or
  agent configuration/skill directories. Secret/environment contents and
  customer data were not searched. This does not establish absence on other
  developers' machines or in unreachable/deleted history.
- `.cursor/rules/ship-and-review-gate.mdc` and `scripts/ship-preflight.sh`
  already call for security review and Bugbot; neither implements the missing
  wrapper or its former `state/` report output.

**The missing script did not run and has not passed.** No substitute executable
was invented, and this documentation repair does not certify a release or waive
findings. Actual review reports, required checks and staging QA must establish
their own results before the normal promotion ladder proceeds.

Validation: inspected the resulting documentation diff and ran `git diff --check`.
No executable code, database, environment, deployment or git history changed as
part of this documentation repair.
