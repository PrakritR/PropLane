# Inbox release final correction handoff

Date: 2026-09-13

Plan: `docs/plans/2026-09-13-inbox-release-final-correction-plan.md`

Branch: `akhil/prp-472-inbox-unread`

Starting and current HEAD: `276e1e40a0a9f3f63bee3a87b4fabbbd9edaf54b`

The bounded R1 and R2 corrections are implemented in the existing frozen working release delta. No Git mutation, server, browser, provider, remote SQL, staging, or production action was performed by this execution session. Root owns the final full release freeze, broad validation, real DEV browser retry QA, corrected rollback-only staging rehearsal, review, and release ladder.

## Result

R1 adds `retryInitialList` in `ManagerUnifiedInbox`. Only the visible initial error Retry action clears the current viewer's SMS authorization halt ref and state, then returns `loadInitialList()`. Automatic initial loads, polling, visibility refreshes, viewer generations, shared unforced loaders, and stale response checks are unchanged. Mounted tests cover initial 401 and 403 followed by a same-viewer explicit Retry, exactly one additional SMS request, and successful row reveal. A separate 401 to 403 to 200 case proves refusal does not install the 20-second poll or permit visibility refocus to bypass the halt, while a later explicit Retry still succeeds.

R2 makes exact existing-trigger validation require `pg_trigger.tgattr::text = ''` for both recovery triggers. The rollback-only probe enforces and displays the same catalog field. Its executable PGlite regression installs a same-name `BEFORE INSERT OR UPDATE OF archived OR DELETE` trigger with the real `public.account_recovery_write_guard()` function, observes the actual migration reject it, rolls the failed transaction back, and verifies the narrowed trigger remains while the companion trigger was not partially installed. Historical migrations, functions, grants, RLS, data, and recovery manifest policy are unchanged.

The previously corrected failed-envelope controller behavior is preserved. Its source and retained test hashes are unchanged from the prior freeze, and the integrated controller/reconciler matrix passed both settlement orders.

## Changed files in this correction

- `src/components/portal/pro-unified-inbox.tsx`
- `tests/unit/inbox-initial-loading-readiness.test.tsx`
- `supabase/migrations/20260913173000_tour_followup_recovery_guards.sql`
- `scripts/testing/tour-followup-recovery-guards-probe.sql`
- `tests/unit/tour-followup-recovery-guards-sql.test.ts`

## Validation

Delegate-focused commands:

- `source ~/.nvm/nvm.sh && nvm exec 22 npm exec vitest run tests/unit/inbox-initial-loading-readiness.test.tsx --maxWorkers=1 --minWorkers=1`: exit 0, 1 file and 29 tests passed.
- `/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin/node ./node_modules/vitest/vitest.mjs run tests/unit/tour-followup-recovery-guards-sql.test.ts --maxWorkers=1`: exit 0, 1 file and 7 tests passed.

Manager-integrated commands, all serialized under explicit Node 22.23.0:

- `/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin/node node_modules/vitest/vitest.mjs run tests/unit/inbox-initial-loading-readiness.test.tsx tests/unit/manager-sms-conversations-client.test.ts tests/unit/unified-inbox-sms-poll.test.tsx tests/unit/portal-inbox-read-observation.test.ts tests/unit/portal-inbox-read-operation.test.ts tests/unit/portal-inbox-read-storage-contract.test.ts tests/unit/pro-sms-panel-opened-retry.test.tsx tests/unit/manager-unified-inbox-read-integration.test.tsx tests/unit/unified-conversation-inbox.test.tsx --no-file-parallelism --maxWorkers=1 --reporter=verbose`: exit 0, 9 files and 88 tests passed.
- `/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin/node node_modules/vitest/vitest.mjs run tests/unit/tour-followup-recovery-guards-sql.test.ts tests/unit/tour-interest-reminder-sql.test.ts tests/unit/account-recovery-capture-sql.test.ts --maxWorkers=1 --reporter=verbose`: exit 0, 3 files and 41 tests passed.
- `/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin/node node_modules/eslint/bin/eslint.js src/components/portal/pro-unified-inbox.tsx tests/unit/inbox-initial-loading-readiness.test.tsx tests/unit/tour-followup-recovery-guards-sql.test.ts --quiet`: exit 0.
- `npx graphify hook-rebuild`: exit 1, `npm error could not determine executable to run`. This is the known local executable-resolution failure. No global tooling was changed, and `.graphify/` was not refreshed.

Root reported its earlier serialized broad unit run passed 1,465 files and 10,345 tests in 586.98 seconds. That run used the prior frozen candidate while these five files were changing, so it is historical evidence only and does not certify this correction freeze.

No browser QA is claimed here. Root has the bounded real DEV same-viewer 401/403 retry exercise prepared and owns that evidence. No corrected staging rollback rehearsal is claimed here; root must rerun it against these exact migration and probe bytes.

## Correction freeze

The five correction files were hashed after all focused checks. The correction aggregate is the SHA-256 of the five `shasum -a 256` lines below in this order: `30a5299bf91d7e94afb173c140ae6e137786776c6743d3f6cd175f47ea72ebe8`.

```text
50d543111bf8043de8fd758b23cb29f11536682ea1f35a584a3998b217ded7e1  src/components/portal/pro-unified-inbox.tsx
ea4553dd96ef89f93ec80efeac85e1a6702a47434c636f68b35405ce0fb3caad  tests/unit/inbox-initial-loading-readiness.test.tsx
0848ed305b3fa742f1b16e75133931718c7c05b10f7b4df760d7ded2467d53a4  supabase/migrations/20260913173000_tour_followup_recovery_guards.sql
2fd90572788bd2c7926bad55f57f4c5c4887fcf855c1d09a77e46706e991d158  scripts/testing/tour-followup-recovery-guards-probe.sql
23a88eebc3d63b81618645f745f5b06b985bbfe8e74ed64f3100b9563e59cf57  tests/unit/tour-followup-recovery-guards-sql.test.ts
```

Protected failed-envelope files remain:

```text
60c1c55b16b53cd8ab4727cef843b55a970c7732d4da5bfabc091d7d660647b3  src/lib/portal-inbox-read-operation.client.ts
c5ed6cfade5fa5b5713977a1bb7928f4701d31fe5ac5d7c0eaa2c7c0ae0eb194  tests/unit/portal-inbox-read-operation.test.ts
```

This is a correction-scope freeze, not the full release freeze. Root must recompute the complete release inventory after confirming no concurrent writes and use that aggregate for fresh Astra, security, and Bugbot review.

## Next session

Read this handoff, the correction plan, final review, Bugbot report, and security review. Verify the full release freeze contains exactly these correction bytes, rerun root-owned broad checks and real DEV Retry QA, repeat the corrected rollback-only staging rehearsal after review, and launch fresh review against the refreshed full candidate. Do not treat prior broad, browser, or staging evidence as proof of these future bytes.
