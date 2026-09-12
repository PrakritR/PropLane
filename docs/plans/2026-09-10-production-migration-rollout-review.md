# Production migration preparation: fresh Astra review

Date: September 11 UTC 2026. Review phase of the Akhil feature cycle.

Reviewed keeper: `akhil/backlog-repeat-issues`, HEAD
`daddb7b5de9910ed3f140ff7d9a63beef48b0547`, with the stable uncommitted
preparation diff. Plan: `2026-09-10-production-migration-rollout-plan.md`.
Execution evidence: `2026-09-10-production-migration-rollout-handoff.md`.

Verdict: changes required before approving the preparation keeper. This review
does not approve the draft waiver, production application, or code promotion.
Correction cycle 1 should follow
`2026-09-10-production-migration-rollout-correction-1.md`.

## Findings

### P1: first-install preflight permits an existing public recovery bucket

`scripts/prepare-20260911-production-migrations.mjs:178` checks prerequisite
relations, and line 182 checks newly created tables/functions/triggers, but
neither checks the `storage.buckets` row for `account-recovery`. The exact source
`supabase/migrations/20260907230000_account_recovery_object_generations.sql:3`
inserts the private bucket with `ON CONFLICT(id) DO NOTHING`.

Consequently, an existing bucket with `public=true` survives a successful bundle
installation. Later recovery archive objects would land in a public bucket.
The earlier remote observation that the bucket was absent does not enforce
that condition inside the installation transaction, and the generated bundle
claims to refuse changed/partial target state.

Reproduced independently using a disposable local PostgreSQL cluster and the
actual `npx -y supabase@2.117.0` apply workflow. An in-memory variant of the
rehearsal inserted only this fixture row after dependency setup, then installed
the unmodified generated bundle. Exact sources and all 12 original ledger rows
installed successfully; `SELECT public FROM storage.buckets WHERE
id='account-recovery'` remained `true`. Exit 0 confirmed the reproduction.
Evidence directory: `/tmp/proplane-migration-rehearsal-wRSv8T`; its cluster was
stopped cleanly. No repository source or remote database was changed.

Required correction: refuse any preexisting `account-recovery` bucket before
source execution, consistent with the bounded first-install contract. Add local
negative rehearsals for both public and private preexisting rows, verify the
rows remain unchanged and no source objects/ledger rows survive. Verify the
clean successful install creates exactly the intended private bucket. Preserve
all 12 source migration bytes.

### P2: deliberate-failure rehearsals accept unrelated CLI failures

`scripts/testing/production-migration-local-rehearsal.mjs:81`, line 91, and
line 111 use unqualified `assert.throws`. Any subprocess error satisfies each
assertion, including a parse failure or an unrelated preflight refusal before
the intended failure location. An empty database then satisfies the rollback
assertions. In particular, the three injected rollback tests do not themselves
prove that execution reached their middle/pre-ledger/post-ledger locations.

The independent run did reach the expected errors: its PostgreSQL log contained
the historical-sentinel exception, rollout-lock exception, and three division
by zero errors. This verifies today's run, but the harness can report a false
pass after a later change. Require the expected SQLSTATE or exact diagnostic
for each intentional failure and reject unrelated command failures.

## Independent verification and accepted behavior

- Node 22 command `npm exec vitest run
  tests/unit/migration-parity-check.test.ts
  tests/unit/production-migration-preparation.test.ts -- --maxWorkers=2`:
  exit 0, 2 files, 59 tests.
- Node 22 `node scripts/testing/production-migration-local-rehearsal.mjs`:
  exit 0. The actual pinned CLI installed exact sources and original ledger SQL,
  exercised sentinel/lock/middle/pre-ledger/post-ledger failures, service-role
  and client access checks, and ordinary public/auth/storage fixture writes.
  Log independently inspected at
  `/tmp/proplane-migration-rehearsal-arwnAH/postgres.log`; expected failures and
  clean cluster shutdown confirmed.
- In-memory public-bucket regression probe described above: exit 0, reproduced
  successful installation retaining `public=true`.
- `git diff --check`: exit 0. HEAD unchanged. Reviewer wrote only this review
  and its correction plan.

The manifest pins exactly 12 source SHA-256 values and stable order. The CLI
entrypoint rejects `--apply` and arbitrary arguments, parses restricted ledger
metadata, creates private temporary files, and emits only a pinned production
dry-run command with `--skip-vault`. It does not connect or load credentials.
The generated SQL consists of guards, exact source statements, and the original
ledger inserts. Exact ledger state rejects partial/conflicting installations;
complete metadata produces no replay workspace. History sentinels fail loudly
if the CLI attempts to execute them.

The parity checker compares exact nonempty names, rejects name/version
ambiguities, refuses named-target mismatches and connection-override query
parameters before database I/O, and suppresses driver errors. Informational
extra names cannot satisfy a missing migration. No finding requests weakening
these safeguards.

No application runtime or historical migration edit was reviewed or made. The
full unit/lint/typecheck results remain execution/root evidence rather than
reviewer reruns. Browser, full E2E, staging/provider acceptance, and
production-sized lock behavior remain outside this local dependency fixture.

## Release boundaries

The waiver remains DRAFT and `--apply` remains forbidden. No production/staging
access or writes, protected-branch pushes, seed/wipe, provider actions, or
no-mistakes ran in this review.

Repository duplicate `agent_pending_actions` names represent different SQL;
staging also has duplicate `resident_invite_links`. Conservative parity must
remain nonzero pending explicit identity reconciliation. Production's earlier
33 missing local names comprise 12 confirmed omissions and 21 unresolved
historical-equivalence cases; its 10 extra applied names are not permission to
guess equivalence. Preparation approval after correction will not mean that the
checker is release-ready or that those outstanding gates have passed.
