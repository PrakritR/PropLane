# Akhil authorized release routing - Bugbot delta review

Date: 2026-09-10

## Scope and provenance

Reviewed only the seven uncommitted active routing documents and the untracked
routing contract test in worktree
`/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/3/AXIS-2`:

- `AGENTS.md`
- `docs/agents/AGENTS-akhil.md`
- `docs/agents/deployment-workflow.md`
- `docs/agents/sandbox-open-review.md`
- `docs/ship-gate.md`
- `.cursor/rules/ship-and-review-gate.mdc`
- `.cursor/rules/sandbox-open-feature-review.mdc`
- `tests/unit/akhil-release-routing-instructions.test.ts`

Observed HEAD: `30ca5d43d978f049f51489b666a2a282d699b029`.
The seven tracked documents contain 92 additions / 57 deletions in the current
working diff. The routing test is untracked and has SHA-256
`4ddc5c14c3b37aaa9ecd378d90c69417eee436afc9caaa0f3217c1acf6888d66`.
The prior PRP-473 source review is not re-reviewed here; the relevant source
scope remains attributable to the prior keeper commit/reviews and is not
production approval.

No source, test, or unrelated documentation was edited by this review. No
commit, push, promotion, PR, database/provider operation, production
application-data write, or no-mistakes invocation occurred.

## Decision

**No actionable Bugbot finding in the bounded routing diff.** The reviewed
changes now express the requested split correctly:

- Akhil's explicit ship request permits only keeper → `main` → `staging` →
  `production`, with no `prakrit` write.
- Without that request, Akhil work remains keeper-only with a Review URL.
- Prakrit retains the captain `keeper → prakrit → main` process.
- Staging, fast-forward-only promotion, production application-data and locked
  listing protections, review/testing gates, TestFlight verification, and the
  no-mistakes prohibition for Akhil remain intact.

The active routing contract test passed:

```text
npx vitest run tests/unit/akhil-release-routing-instructions.test.ts --maxWorkers=1
exit 0 - 1 file, 4 tests
```

`git diff --check` passed with exit 0 for the seven tracked routing documents.

## Findings

None at P0, P1, P2, or P3 within the bounded scope.

The separate live Vercel project correction is represented consistently in the
reviewed documentation as `proplane`
(`prj_rupckw3T2v0oXVg2nTLVCYePKDUc`), with production branch `production` and
staging variables scoped to the `staging` branch. The generic Preview
environment's production-shared defaults are called out as unsafe for staging.

## Release disposition and remaining gates

This is a **keeper-only Bugbot disposition**, not a release or production
approval. Full E2E was not run. Staging QA and handset/provider acceptance also
remain pending. Root's read-only schema evidence
(`docs/plans/2026-09-10-akhil-release-schema-evidence.md`) confirms production
omissions: the webhook tables and the eleven recovery/preservation migrations'
relations/functions are absent, while representative relations are present on
staging. This requires a separately reviewed and authorized production database
remediation; it is not a captain-permission issue and must not be fixed by
blindly replaying the ledger. The latest preflight independently failed on
missing remote `origin/staging`; shell-local production variables and database
connection information were absent, so those warnings do not prove Vercel
Production configuration is missing.

The separate stale `axis-2` references in manual Vercel shell-script comments
were outside this bounded seven-document/test scope and are not certified by
this report.
