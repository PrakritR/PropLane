# Communication billing rollout correction 1 handoff

Execution handoff, September 11 2026. This correction implements only the
bounded validation-evidence plan in
`docs/plans/2026-09-11-comms-billing-rollout-review.md`. The preparation CLI,
candidate SQL bundle, proposed correction SQL, five pinned source objects, and
consumed recovery runner/certificate/waiver were not changed.

## Repository state and scope

- Worktree: `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/3/AXIS-2`
- Branch: `akhil/backlog-repeat-issues`
- Starting and current HEAD:
  `dbb3836e36ec23abd347f16d3eb1b7df7270b015`
- Changed correction files:
  `scripts/testing/comms-billing-migration-local-rehearsal.mjs`,
  `docs/plans/2026-09-11-comms-billing-rollout-handoff.md`, and this handoff.
- No remote call, credential read, provider action, apply, commit, push, merge,
  deployment, migration, or protected-branch mutation occurred. The waiver
  remains DRAFT.

Terra owned the rehearsal edit. Luna independently reviewed the test and source
risks read-only. Sol integrated Luna's findings by requiring exact exception
messages, complete nonempty baseline snapshots, a real old-shape settings write,
the legacy meter name, and total wallet balance rather than one balance column.

## Corrected PostgreSQL evidence

The disposable localhost rehearsal now:

- runs the actual stable bundle against one qualifying payment-preference
  backfill row, requires the exact preflight exception, and uses a fresh
  connection to prove the settings, usage, and full historical ledger are
  preserved while every candidate table, column, function, index, and ledger
  identity remains absent;
- splices test-only SQL exceptions after exact source markers 1, 5, and 6 in
  the actual generated bundle, requires each exact intended exception, and
  proves the same full rollback and preservation invariants from a fresh
  connection;
- after clean installation, inserts a legacy `sms_outbound_segment` usage row
  with omitted credit fields and inserts/updates an old-shape settings row with
  omitted `manual_payments`, proving defaults and prior values remain valid;
- requires all 80 concurrent reservation promises to fulfill, exactly 66 to be
  allowed, exactly 14 to deny with `allowance_exhausted`, 66 reserved usage
  rows, and a final combined included-plus-purchased balance of 2 cents.

An initial stricter rehearsal run exposed an invalid UUID in the existing
campaign retry fixture. The fixture was corrected to reuse the exact two valid
inserted UUIDs. The final run passed.

## Fingerprints

- Preparation entrypoint:
  `cff0016ba1799b75ddb295b83c66f921c56857e5e7d0f675adcd9c73fd91787b`
- Atomic bundle: 67,040 bytes,
  `c8013155b6cb51792950177cd47b348d51d7ce24df7869a5892ec74bb29541ff`
- Proposed correction SQL:
  `229e0699bc0e4685dc8ba2f6380ef9d2358816a1d72415abe7d4adb7a9c49713`
- Local rehearsal:
  `14495cd2db5e7a29445d4c7aad3c174398ece4833a8c1a2fc23f9139cd795def`
- Unit test:
  `50e7be20240c36f66d2bcbbdb4aa51999d97acc9d7aa2c99617bfa5eefa6f212`
- Consumed CA certificate:
  `700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7`

## Commands and results

- `node --check scripts/prepare-20260911-comms-billing-migrations.mjs` - exit 0.
- `node --check scripts/testing/comms-billing-migration-local-rehearsal.mjs` - exit 0.
- `node scripts/testing/comms-billing-migration-local-rehearsal.mjs` - exit 0.
- `npx vitest run tests/unit/comms-billing-migration-preparation.test.ts --maxWorkers=1` - exit 0, one file and nine tests passed in 1.44 seconds.
- `npx eslint scripts/prepare-20260911-comms-billing-migrations.mjs scripts/testing/comms-billing-migration-local-rehearsal.mjs tests/unit/comms-billing-migration-preparation.test.ts` - exit 0.
- `node scripts/prepare-20260911-comms-billing-migrations.mjs` - exit 0;
  reported the unchanged 67,040-byte bundle and exact digest above.
- `shasum -a 256 scripts/prepare-20260911-comms-billing-migrations.mjs scripts/testing/comms-billing-migration-local-rehearsal.mjs tests/unit/comms-billing-migration-preparation.test.ts scripts/rollouts/2026-09-11-comms-billing/20260911160000_comms_credit_recovery_guards.sql scripts/lib/supabase-root-2021.crt` - exit 0 with the fingerprints above.
- `git diff --exit-code HEAD -- supabase/migrations scripts/prepare-20260911-production-migrations.mjs scripts/testing/production-migration-local-rehearsal.mjs scripts/lib/supabase-root-2021.crt docs/waivers/2026-09-11-production-recovery-schema.md` - exit 0.
- `git diff --check` - exit 0.
- `npx graphify hook-rebuild` - exit 1, `npm error could not determine executable to run`. This keeper has no graph state and no substitute graph runtime was generated.

No browser QA was run because correction 1 changes only the disposable local
PostgreSQL rehearsal and evidence. Application and staging QA remain later
release gates in the original handoff.

## Next review

Fresh GPT-6 Astra should read the original plan, original review, and this
handoff; inspect only the rehearsal and evidence correction; rerun the focused
commands above; verify the three immutable identities; and decide whether the
five bounded review findings are closed. It must not contact a remote target,
add apply capability, approve the DRAFT waiver, commit, push, merge, or deploy.
