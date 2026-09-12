# Communication billing and tour fix release

Astra plan for Akhil's explicit request: "get it on prod asap". This authorizes
the release workflow, not bypassing the named production schema waiver or QA.
Starting keeper `akhil/backlog-repeat-issues` at
`97815a2d459c0bf96e9e80d4f94d29bff7d23fe2`, in
`/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/3/AXIS-2`.
Pinned main/staging `8ce3868b4e5775661956c6c3f36fcb146bfa931a`; live code
`2d1353af42c3a652be6cf8a69640468b453f4cea`. Root fetched these refs this turn.
The original checkout and pre-existing untracked documents are user-owned.

## Execution scope and ownership

Fresh Sol-medium manages integration, verification and handoff. Terra owns the
new fixed runner `scripts/apply-20260911-comms-billing-migrations.mjs` only.
Luna owns `tests/unit/comms-billing-migration-apply.test.ts` and independent
read-only boundary review. Assign these once. Sol owns the keeper merge,
dispatcher conflict composition, canonical SQL adoption, a focused dispatcher
integration regression if needed, and release/waiver documentation. Delegates
must explicitly set the correct workdir on every command. No remote/provider
operations, credentials, commits, pushes or protected-branch changes by delegates.
Use exact models and the feature cycle. No no-mistakes.

Read AGENTS, Akhil instructions, deployment/database/ship gates, SMS and billing
area docs, recovery design, previous preparation and correction handoffs/reviews.
The repository docs override generic Vercel-deploy procedures. No direct CLI
deployment, no new Vercel project, no change to production branch configuration.

## Integrate on the keeper only

Use a no-commit merge of the pinned main into this keeper after checking the
tracked worktree/index are clean. Do not touch existing untracked documents.
There is one known conflict: `src/lib/sms/owner-sms-dispatcher.server.ts`.
Main owns the NEW wallet reservation/settlement, amount-aware billing gate,
credit-unavailable deferral, and `spend_sms_outbox_segment_budget` idempotence.
Keeper owns `validateTourSmsPurposeAtDispatch` plus its five lifecycle purpose
names and final-boundary provenance/revocation validation. Retain BOTH. Never
restore the old PAYG-only metering or erase tour eligibility to resolve conflict.
Test the combination, including consent refusal before credit/provider work and
allowed consent retaining main's wallet/campaign behavior. No UI redesign.

Adopt the proposed correction into
`supabase/migrations/20260911160000_comms_credit_recovery_guards.sql` with
identical bytes using apply_patch. Its five prerequisite sources now come from
the merge. Keep the existing rollout artifact and manifest bytes unchanged.
Check migration uniqueness and account-purge coverage after adoption.

## Fixed apply runner

The reviewed preparation entrypoint stays byte-identical:
`cff0016ba1799b75ddb295b83c66f921c56857e5e7d0f675adcd9c73fd91787b`.
Bundle: 67040 bytes,
`c8013155b6cb51792950177cd47b348d51d7ce24df7869a5892ec74bb29541ff`.
Correction: `229e0699bc0e4685dc8ba2f6380ef9d2358816a1d72415abe7d4adb7a9c49713`.
Consumed recovery runner, original recovery rehearsal/SQL and CA are immutable.
Reuse their reviewed pg design without refactoring or invoking their apply path.

CLI supports a closed enum of operations: manifest-only default,
`--preflight-staging`, `--verify-staging`, `--apply-staging`,
`--preflight-production`, `--verify-production`, `--apply-production`.
Apply requires exact `--bundle-sha256` acknowledgement. Production apply also
requires `--waiver 2026-09-11-production-comms-billing`, and an explicitly
APPROVED, not consumed waiver on disk whose runner digest matches this file.
The root will record approval only after Akhil approves the final named scope.
Preflight/verify are read-only and do not require an approved waiver. Reject
unknown, duplicate, mixed operations, URLs, arbitrary paths/SQL/ledgers and env
target overrides. Fixed target mapping only: staging xwszcafaontidfgznlxd,
production qahnczmilgptcedaqype. No other target or automatic retry.

Acquire transient credentials with pinned Supabase CLI2.117.0 read-only
`db dump --dry-run` in a private mkdtemp workspace, minimal config and explicit
environment allowlist. Never load project .env in that CLI cwd, run its emitted
shell, inherit PG/SSL override variables, print or persist credentials, SQL,
provider/account data or raw DB/CLI errors. Parse exactly one of each expected
PG variable; bind host/user to the exact target, port5432/database postgres.
Use existing pinned CA `scripts/lib/supabase-root-2021.crt`, SHA
`700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7`, verified
hostname and rejectUnauthorized. Attach asynchronous pg error listeners before
connect; bound operations and sanitize all failures. No credential caches/files.

Preflight reads only metadata/ledger/counts inside BEGIN READ ONLY and rolls back.
Require the exact target source/aux names AND versions absent, all new artifacts
absent, compatible manual_payments, recovery/spend prerequisites intact, zero
eligible backfill, no lock waiters/long transactions. Preserve historical
duplicates, never repair unrelated ledger history. Recheck before transaction.

CRITICAL: this billing bundle already contains BEGIN and COMMIT. Do NOT send it
whole and then insert the auxiliary ledger row: that would commit early.
Validate its fixed digest first, then strip ONLY its exact outer `begin;\n`
and `commit;\n` framing for transport. Open one driver transaction, SET LOCAL
ROLE postgres, execute the identical interior, insert the auxiliary row with
statements=[COMPLETE unchanged bundle], verify schema and all seven ledger rows,
then COMMIT once. Preserve source statements=[exactSource]. No general SQL input.
Run transaction preconditions/postchecks already in the approved bundle and add
read-only catalog/ledger checks as needed for before-commit and fresh readback.
Never rerun modifying sources as a verification technique.

Close original connection and independently verify fresh TLS readback after
success, failure or uncertain commit. Report success only with confirmed COMMIT
AND exact installed catalog/ledger; report clean rollback only with proven
rollback and exact prior state; all else uncertain/partial, nonzero and NO retry.
Verification must include exact function identities/effective privileges, all
four enabled recovery triggers, RLS, defaults/constraints/indexes/singleton,
six source statements + completeBundle and preserved historical ledger rows.

## Validation and handoff

Unit tests cover CLI refusal, target binding, source/bundle/CA drift, approved
waiver/runner identity, hostile PG/env, sanitization, read-only preflight/verify,
transaction order/no early COMMIT, auxiliary insertion and catalog rollback,
fresh readback, timeout/async/disconnect/uncertain COMMIT with no retry. Reuse
existing local rehearsal and pg/TLS harnesses for real driver behavior where
practical; no remote test target. Test failure assertions must identify the
intended failure, not swallow unexpected errors.

Run focused migration/tour/dispatcher/billing tests first, syntax/scoped lint,
existing actual local PG rehearsal, hashes/diff checks, canonical migration
uniqueness/purge coverage. After merge run full unit, typecheck and production
build pinned to dev/test, never .env.production. Surface real failures. Root
will coordinate independent release security/bugbot and fresh Astra review,
then keeper commit and fast-forward main/staging under ship gate. Record exact
commands/exit codes and any blocked gates in
`docs/plans/2026-09-11-comms-billing-release-handoff.md`.
Update the DRAFT waiver with final fixed runner path/digest and explicit later
approval status; do not mark approved or consume it. Attempt graph refresh,
document unavailable runtime rather than install a different graph engine.

## Root release sequence after reviewed handoff

1. Review and commit integrated keeper. Preserve all unrelated work.
2. Required security/bugbot, full unit/lint/type/build and seeded browser QA.
   For messaging, use Twilio/Langfuse readback and designated QA contacts only.
3. Fast-forward main then staging. Confirm staging Vercel deployment uses
   staging-scoped DB credentials and exact release SHA. No generic Preview env.
4. Apply ONLY six reviewed sources to staging through reviewed fixed runner;
   full staging billing/tour/recovery/browser/rollback QA, not only public smoke.
5. Verify old current/rollback invoicer cannot charge prepaid usage, leaving
   COMMS_PAYG_BILLING_ENABLED disabled. Do not enable topups or change provider
   configuration just to make tests pass. Run ship:preflight.
6. Fresh bounded production safety preflight (<5min). Ask Akhil for the exact
   named waiver/fixed runner approval if absent. Approval cannot be inferred from
   the preparation approval or reused recovery waiver. Stop for genuine gates.
7. Apply once, independent schema readback, consume waiver only on success.
   Fast-forward staging to production, verify Vercel and TestFlight distribution.
   No production user/account/message/payment tests beyond separately authorized
   named scope. Never claim local/staging evidence as production testing.
