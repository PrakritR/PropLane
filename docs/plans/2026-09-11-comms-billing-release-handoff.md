# Communication billing and tour release handoff

Date: 2026-09-11

Status: **LOCAL INTEGRATION COMPLETE; RELEASE BLOCKED ON REVIEW, STAGING DEPLOYMENT/QA, AND PRODUCTION APPROVAL**

## Integrated source

- Keeper: `akhil/backlog-repeat-issues`
- Keeper HEAD remains `97815a2d459c0bf96e9e80d4f94d29bff7d23fe2`; no commit was created.
- Pinned main merged with `--no-commit --no-ff`: `8ce3868b4e5775661956c6c3f36fcb146bfa931a`.
- The sole merge conflict was `src/lib/sms/owner-sms-dispatcher.server.ts`.
- Resolution retains main's amount-aware billing, campaign allocation,
  `reserveCommsCredit`/`finishCommsCredit`, and credit deferral together with
  the keeper's five tour lifecycle purposes and final dispatch-boundary tour
  authority check.
- A release security review found that claimed rows dropped
  `recipient_user_id` while rebuilding send policy. The dispatcher now carries
  that identity into the final suppression check. A changed-phone regression
  proves user-keyed STOP blocks before campaign allocation, wallet reservation,
  or provider submission.
- No remote, credential, provider, deployment, commit, push, or protected-branch
  mutation was performed. Pre-existing user-owned untracked files were not
  modified except the release-plan/waiver artifacts explicitly in this scope.

## Fixed schema artifacts

- Preparation entrypoint: `scripts/prepare-20260911-comms-billing-migrations.mjs`
  - SHA-256 `cff0016ba1799b75ddb295b83c66f921c56857e5e7d0f675adcd9c73fd91787b`
- Atomic bundle: 67,040 bytes
  - SHA-256 `c8013155b6cb51792950177cd47b348d51d7ce24df7869a5892ec74bb29541ff`
- Canonical correction: `supabase/migrations/20260911160000_comms_credit_recovery_guards.sql`
  - 1,579 bytes
  - SHA-256 `229e0699bc0e4685dc8ba2f6380ef9d2358816a1d72415abe7d4adb7a9c49713`
- Fixed runner: `scripts/apply-20260911-comms-billing-migrations.mjs`
  - 26,571 bytes
  - SHA-256 `bd4f1f687c02329164e25cc439e0f62a0d699a6bf49f8692c94b076d944b57d7`
- Runner unit test: `tests/unit/comms-billing-migration-apply.test.ts`
  - 17,138 bytes
  - SHA-256 `434d1abd3051e5c9cf9ccd7bedb65ef55f2dad5cea2bde02bcfa614cdb7e9818`
- TLS CA: `scripts/lib/supabase-root-2021.crt`
  - SHA-256 `700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7`

The runner validates the full reviewed bundle hash before stripping only the
exact outer `begin;\n` and `commit;\n`. It opens one driver transaction,
executes the unchanged interior, inserts the auxiliary ledger row containing
the complete bundle, checks the catalog and ledger, and issues one COMMIT.
Fresh rollback classification requires the complete readback to equal the
complete prior catalog state. Installed verification checks each table
privilege separately, exact column shapes, exact function identities and safe
configuration, triggers, RLS, indexes, constraints, singleton, and ledger.

The named waiver remains **DRAFT - NOT APPROVED, NOT APPLY-CAPABLE, NOT
CONSUMED**. Its candidate runner fingerprint was updated; it grants no authority.

## Validation evidence

- Runner + dispatcher focused suite:
  `vitest run tests/unit/comms-billing-migration-apply.test.ts tests/unit/sms-conversation-log-dispatch.test.ts --maxWorkers=1 --reporter=verbose`
  - exit 0; 2 files, 21 tests passed.
- Scoped runner/dispatcher ESLint and runner syntax check in the same command:
  - exit 0; no warnings or errors.
- Migration uniqueness, account purge, tour and dispatcher focus:
  - exit 0; 5 discovered files, 37 tests passed.
- Earlier combined preparation, purge and dispatcher focus:
  - exit 0; 23 tests passed.
- Earlier migration/tour/dispatcher focus:
  - exit 0; 36 tests passed.
- Existing local PostgreSQL rehearsal:
  `node scripts/testing/comms-billing-migration-local-rehearsal.mjs`
  - exit 0; disposable localhost PostgreSQL passed recovery gap/correction,
    held-write/delete-capture recovery, exact ledger/auxiliary identity,
    rollback/conflict/backfill locking, wallet/campaign concurrency, and catalog/RLS.
- `git diff --check` plus explicit checks for both untracked runner/test:
  - exit 0.
- The first full-unit run (`npm run test:unit`) was started while source
  finalization and a compiler were also active. It surfaced one pre-existing
  manager inbox draft failure and one transient failure of the newly added STOP
  regression (which passes in the isolated final focused suite). It was
  deliberately interrupted with exit 130 after about nine minutes to remove
  resource contention and avoid treating an across-edits run as final evidence.
- The concurrent first `tsc --noEmit` was likewise interrupted with exit 130;
  it produced no diagnostics before interruption.
- A clean full-unit rerun on stable sources is in flight with
  `vitest run tests/unit --maxWorkers=2 --reporter=dot`, unified exec session
  `64008`. It has no separate log file; its output is retained by that session.
  Typecheck and production build remain pending and must run sequentially after
  this unit process. No compiler or build is currently running.

No remote database was contacted by these tests. The local rehearsal exercises
the reviewed bundle; the new runner's transport boundary is hermetically tested
with injected PostgreSQL clients and was not used against a remote target.

## Independent review and remaining gates

- Fresh Luna read-only runner review initially identified unsafe prefix-only
  `search_path` validation, shallow clean-state readback, and incomplete boundary
  coverage. The two high findings were corrected. Its medium coverage finding
  remains visible for fresh Astra assessment: the suite does not subprocess-test
  every private CLI workspace/environment edge or a successful production waiver
  transition, because the real waiver must remain DRAFT.
- Independent application security and bugbot reports are recorded in
  `docs/security/2026-09-11-release-security-review.md` and
  `docs/security/2026-09-11-release-bugbot-review.md`. Broader speculative claims
  were not changed during this focused integration.
- Root reported fresh read-only staging/production inventories with all five
  target migrations absent, zero qualifying backfill/activity, and the runtime
  flag absent. Those are root-owned preparation facts and must be rechecked by
  the fixed runner immediately before any apply.
- Root then ran the fixed runner's `--preflight-staging` operation at 17:21 UTC:
  exit 0, six sources, historical ledger count 187, four other sessions, zero
  active sessions, zero long transactions, and zero lock waiters. This was a
  read-only operation only; see
  `docs/plans/2026-09-11-comms-billing-release-root-evidence.md`.
- The latest nightly `e2e-full` run `34589386066` reported 52 failed, 110 passed,
  and 2 not run. Root reproduced the 375px inbox composer click interception;
  the relevant component is unchanged from live, but affected browser QA remains
  blocked and must not be waived or repaired as part of this runner handoff.
- The staging workflow `34552913754` was a no-op because `VERCEL_TOKEN` was not
  configured; the deployed staging revision therefore does not yet represent
  this release. Root owns that deployment gap.
- Fresh Astra review, keeper commit, fast-forward main/staging, an exact staging
  deployment, staging schema apply and full staging QA are still required.
- Production needs a fresh bounded preflight and Akhil's explicit approval of
  `2026-09-11-production-comms-billing` at the recorded runner hash. An uncertain
  result is never retried. Production deployment remains gated; the production
  schema write and communication-credit flag enablement have no approved waiver.

## Final command addendum

This section records incomplete final gates without presenting them as green.

- Graph refresh: `npx graphify hook-rebuild` exited 1 because npm could not
  determine an executable to run. No alternate graph engine was installed.
