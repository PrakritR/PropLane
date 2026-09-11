# Communication billing correction 1: independent Astra review

September 11, 2026. Review duration approximately 2 minutes. Reviewed in
`/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/3/AXIS-2` on
`akhil/backlog-repeat-issues`, HEAD
`dbb3836e36ec23abd347f16d3eb1b7df7270b015`.

Disposition: **approved for preparation keeper only**. All five bounded
requests in `2026-09-11-comms-billing-rollout-review.md` are closed. No remaining
blocking finding or correction 2 is required within this scope. The named
production waiver remains **DRAFT, NOT APPROVED, NOT APPLY-CAPABLE**.

## Correction evidence

1. The actual generated bundle runs against a qualifying backfill row and must
   return the exact `payment preference backfill must be zero` exception.
   A new connection compares settings and the complete historical ledger with
   their baseline and checks candidate artifact and ledger absence.
2. Test-only SQL exceptions are inserted after exact source markers 1, 5, and
   6 in the generated bundle. Exact exception matching prevents an earlier
   incidental failure from passing. After disconnecting the failed transaction,
   fresh connections verify preserved nonempty settings, usage, and historical
   ledger baselines, with candidate tables, columns, RPCs, indexes, and source
   plus auxiliary ledger identities absent. Absent credit tables also imply
   absence of their correction triggers.
3. After clean installation, a legacy `sms_outbound_segment` usage insertion
   omits credit fields and receives legacy/zero defaults. Old-shape settings
   insert/update omits `manual_payments`, preserves existing JSON keys, and
   retains the empty canonical default.
4. All 80 reservation promises must fulfill; 66 allow, 14 explicitly return
   `allowance_exhausted`, 66 usage rows remain reserved, and the combined wallet
   balance is 2 cents. Unexpected rejected promises now fail the rehearsal.
5. The handoff now names the consumed `scripts/lib/supabase-root-2021.crt`.
   Its independently verified hash matches the preceding review.

The preparation builder, bundle, proposed correction, and unit-test hashes
match the independently reviewed prior identities. This review relies on that
unchanged implementation assessment and reviews the correction only.

## Independently rerun commands

All commands used the worktree above. No remote target or credential was used.

- `node scripts/testing/comms-billing-migration-local-rehearsal.mjs`: exit 0,
  disposable localhost PostgreSQL rehearsal passed and cleaned up.
- `npx vitest run tests/unit/comms-billing-migration-preparation.test.ts --maxWorkers=1`:
  exit 0, nine tests passed, reported duration 2.56 seconds.
- `npx eslint scripts/prepare-20260911-comms-billing-migrations.mjs scripts/testing/comms-billing-migration-local-rehearsal.mjs tests/unit/comms-billing-migration-preparation.test.ts`:
  exit 0.
- `node --check scripts/prepare-20260911-comms-billing-migrations.mjs`: exit 0.
- `node --check scripts/testing/comms-billing-migration-local-rehearsal.mjs`: exit 0.
- `node scripts/prepare-20260911-comms-billing-migrations.mjs`: exit 0;
  67,040 bytes, SHA-256
  `c8013155b6cb51792950177cd47b348d51d7ce24df7869a5892ec74bb29541ff`.
- `shasum -a 256 scripts/prepare-20260911-comms-billing-migrations.mjs scripts/testing/comms-billing-migration-local-rehearsal.mjs tests/unit/comms-billing-migration-preparation.test.ts scripts/rollouts/2026-09-11-comms-billing/20260911160000_comms_credit_recovery_guards.sql scripts/lib/supabase-root-2021.crt`:
  exit 0; all five exact fingerprints match correction 1's handoff. Rehearsal:
  `14495cd2db5e7a29445d4c7aad3c174398ece4833a8c1a2fc23f9139cd795def`.
- `git diff --exit-code HEAD -- supabase/migrations scripts/prepare-20260911-production-migrations.mjs scripts/testing/production-migration-local-rehearsal.mjs scripts/lib/supabase-root-2021.crt docs/waivers/2026-09-11-production-recovery-schema.md`:
  exit 0.
- `git diff --check`: exit 0.

No application/browser QA is claimed for this local test/documentation
correction. The original staging, application integration, canonical correction
adoption, invoicer cutover, fixed apply-runner review, fresh target checks, and
separate explicit waiver approval gates remain. No commit, push, merge, deploy,
provider action, account action, remote apply, or no-mistakes pipeline occurred.
