# Communication billing rollout preparation handoff

Execution handoff, September 11 2026. Plan:
`docs/plans/2026-09-11-comms-billing-rollout-plan.md`.

## Result and repository state

The preparation-only six-source candidate is implemented and locally validated.
It contains the exact five pinned Git sources plus one fixed proposed recovery
guard correction. It has no apply or remote capability. No database outside a
disposable localhost PostgreSQL cluster was contacted or changed.

- Worktree: `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/3/AXIS-2`
- Branch: `akhil/backlog-repeat-issues`
- Starting HEAD: `dbb3836e36ec23abd347f16d3eb1b7df7270b015`
- Current HEAD: `dbb3836e36ec23abd347f16d3eb1b7df7270b015`
- No commit, push, merge, deployment, migration, provider call, or protected
  branch mutation occurred.

## Decisions and artifacts

- The five existing migrations are loaded only from pinned Git commit
  `8ce3868b4e5775661956c6c3f36fcb146bfa931a`. Exact byte count and digest
  mismatches fail closed. They were not copied into this older keeper.
- The proposed correction remains under `scripts/rollouts/` until main is
  integrated. Its stabilized identity is 1,579 bytes and SHA-256
  `229e0699bc0e4685dc8ba2f6380ef9d2358816a1d72415abe7d4adb7a9c49713`.
- `buildAtomicBundle` revalidates every supplied source object, starts one
  explicit transaction, sets 3-second lock and 60-second statement timeouts,
  takes a dedicated advisory lock, locks automation settings, rejects dirty or
  conflicting state, verifies postconditions, and records six exact source
  ledger rows.
- A deterministic auxiliary ledger row builder represents the full bundle as
  one statement without making the bundle hash self-referential. The localhost
  rehearsal inserts and reads it back in the same transaction.
- DRAFT waiver: `docs/waivers/2026-09-11-production-comms-billing.md`.

Fingerprints:

- Preparation entrypoint: `cff0016ba1799b75ddb295b83c66f921c56857e5e7d0f675adcd9c73fd91787b`
- Atomic bundle: 67,040 bytes,
  `c8013155b6cb51792950177cd47b348d51d7ce24df7869a5892ec74bb29541ff`
- Local rehearsal: `14495cd2db5e7a29445d4c7aad3c174398ece4833a8c1a2fc23f9139cd795def`
- Unit test: `50e7be20240c36f66d2bcbbdb4aa51999d97acc9d7aa2c99617bfa5eefa6f212`

## Local evidence

The real PostgreSQL rehearsal starts live-era billing, automation, SMS, and
compatible `manual_payments` dependencies before installing the actual recovery
migrations. It then proves that the original five sources omit recovery guards,
and that the proposed correction closes the gap.

Behavior exercised:

- insert/update blocking for held account-owned credit history;
- delete capture and recovery of purchase plus adjustment in FK-safe order;
- repeated correction idempotence with exactly four correct triggers;
- exact test-injected failure after source 1, source 5, and the correction in
  the actual generated bundle, with fresh-connection rollback proof;
- clean atomic install, dirty object, partial ledger, conflicting ledger, and
  repeat-bundle rejection;
- compatible pre-existing `manual_payments`, precise four-shape backfill
  semantics, zero-row gate, and a concurrent settings writer blocked by the
  relation lock;
- read-only wallet snapshot, existing-manager grandfathered allowance, and
  reservation idempotency;
- all 80 concurrent reservations fulfilled, with exactly 66 allowed, 14
  explicit `allowance_exhausted` denials, and a final two-cent balance;
- old-live usage insertion and old-shape settings insert/update compatibility;
- concurrent campaign cap plus same-message/day retry idempotency using the
  canonical `spend_sms_segment_budget` implementation;
- RLS, browser denial, service-role privileges, RPC identities/configuration,
  credit defaults/constraints, partial customer index, UTC alerts, singleton
  policy, exact historical ledger preservation, six exact source rows, and the
  auxiliary complete-bundle row.

Commands and results:

- `node scripts/testing/comms-billing-migration-local-rehearsal.mjs` - exit 0.
- `node --check scripts/prepare-20260911-comms-billing-migrations.mjs` - exit 0.
- `node --check scripts/testing/comms-billing-migration-local-rehearsal.mjs` - exit 0.
- `npx vitest run tests/unit/comms-billing-migration-preparation.test.ts --maxWorkers=1` - exit 0, 1 file / 9 tests passed.
- `npx eslint scripts/prepare-20260911-comms-billing-migrations.mjs scripts/testing/comms-billing-migration-local-rehearsal.mjs tests/unit/comms-billing-migration-preparation.test.ts` - exit 0.
- `git diff --check` - exit 0.
- `node scripts/prepare-20260911-comms-billing-migrations.mjs` - exit 0 and printed the sanitized six-source manifest and fingerprints above.
- `git diff --exit-code HEAD -- supabase/migrations scripts/prepare-20260911-production-migrations.mjs scripts/testing/production-migration-local-rehearsal.mjs scripts/lib/supabase-root-2021.crt docs/waivers/2026-09-11-production-recovery-schema.md` - exit 0. Pinned sources and consumed recovery artifacts were unchanged.
- `npx graphify hook-rebuild` - exit 1, `npm error could not determine executable to run`. This keeper has no graph state; no substitute runtime was generated.

No browser route was exercised because this phase changes only preparation SQL,
CLI, and localhost database validation. Full application/browser QA is a later
release gate.

## Remaining gates and risks

- Fresh Astra review must independently inspect this exact diff and evidence.
- Integrate main without silently resolving the known dispatcher/application
  conflict, then adopt the correction into canonical migrations with identical
  bytes and rerun affected schema/account-purge coverage.
- Implement a fixed, certificate-verified, no-generic-input apply entrypoint;
  independently review and fingerprint it. The current CLI must remain
  preparation-only.
- Apply and test the complete candidate on staging, then run the billing,
  messaging, account deletion/recovery, checkout/webhook, portal, and rollback
  application QA required by the main implementation.
- Prove the old invoicing cron/helper cannot bill prepaid usage in current and
  rollback deployments. Vercel metadata now supports the inference that
  `COMMS_PAYG_BILLING_ENABLED` is absent, but it is not runtime rollback proof.
- Immediately before any future production operation, repeat read-only ledger,
  catalog, backfill, activity, lock, environment, and deployment checks. Obtain
  Akhil's explicit approval of the new named DRAFT waiver and final apply-runner
  hash. Do not reuse the consumed recovery waiver.

## Exact next-session prompt

Review `docs/plans/2026-09-11-comms-billing-rollout-plan.md`, this handoff, and
the DRAFT waiver as a fresh GPT-6 Astra reviewer. Diff only the six new rollout
artifacts and the two root plan/evidence inputs. Independently rerun the focused
unit test, localhost rehearsal, syntax/lint, hashes, and unchanged-source checks.
Assess atomicity, source pinning, ledger representation, recovery guards,
privilege/RLS postchecks, backfill lock semantics, concurrency coverage, CLI
input boundaries, and waiver wording. Report findings with severity and exact
file/line references. Do not add apply capability, contact any remote target,
commit, push, merge, deploy, or approve the DRAFT waiver.
