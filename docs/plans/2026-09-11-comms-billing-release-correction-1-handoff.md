# Communication billing release correction 1 handoff

Date: 2026-09-11

Status: **LOCAL CORRECTION INTEGRATED; FRESH ASTRA REVIEW AND ROOT RELEASE GATES REQUIRED**

Plan: `docs/plans/2026-09-11-comms-billing-release-correction-1.md`, under the original release plan and review. This handoff grants no database, provider, deployment, Git, or production authority. The production waiver remains DRAFT.

## Checkout and scope

- Workdir for every command: `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/3/AXIS-2`.
- Keeper: `akhil/backlog-repeat-issues`.
- Starting and current HEAD: `97815a2d459c0bf96e9e80d4f94d29bff7d23fe2`.
- The existing no-commit merge of `8ce3868b4e5775661956c6c3f36fcb146bfa931a` remains pending.
- No Git mutation, commit, push, remote credential, database, provider, deployment, no-mistakes, Linear, or Lavish operation occurred.
- The frozen preparation runner, six source bundle, canonical correction, previous rehearsal, consumed recovery artifacts, and CA were not edited. No target override, generic SQL input, retry path, subscription idempotency redesign, or campaign budget reorder was added.

## Integrated decisions and files

### Fixed apply runner and verification

- `scripts/apply-20260911-comms-billing-migrations.mjs`
  - Catalog verification now checks effective SELECT, INSERT, UPDATE, and REFERENCES column privileges for anon, authenticated, and service role.
  - Both required indexes are checked by relation, uniqueness, validity, key count, complete `pg_get_indexdef`, and predicate.
  - Relevant usage constraints are compared by exact catalog definition.
  - Real PostgreSQL exposed and corrected one integration defect in the first exact-index implementation: `pg_get_indexdef` includes the partial unique index's `WHERE (stripe_customer_id IS NOT NULL)` clause.
- `tests/unit/comms-billing-migration-apply.test.ts`
  - Adds negative fixtures for column-only client grants, same-name nonunique and wrong-key indexes, and weakened constraints.
- `scripts/testing/comms-billing-migration-apply-local-harness.mjs`
  - New dedicated harness copies prerequisite setup logic without modifying or exporting from the frozen rehearsal.
  - Runs the actual fixed runner and exact bundle through disposable localhost PostgreSQL using real `pg`.
  - Proves confirmed COMMIT plus independent readback, exact eight-row ledger with historical row preserved, rollback after auxiliary insertion failure and before-commit catalog failure, real statement timeout, real backend disconnect, and lost-COMMIT-response uncertainty with one interior execution and no replay.
  - After a confirmed install, real catalog mutations prove verification rejects a REFERENCES-only anon column grant, the same partial-index name with wrong keys, and the same constraint name with a weakened expression.
  - Starts a separate local TLS-enabled PostgreSQL fixture with a temporary self-signed test certificate, proves trusted-host connection, and rejects wrong-hostname and untrusted-certificate connections. Operational CA and hostname verification remain unchanged.
- `tests/unit/comms-billing-migration-apply-local-harness.test.ts`
  - Spawns the dedicated harness using the current Node executable and requires its complete success marker.
- `tests/unit/comms-billing-migration-apply-subprocess.test.ts`
  - Runs copied entrypoints with local fake Git and pinned Supabase CLI executables.
  - Proves exact CLI version/arguments/production target, 0700 workspace/directory modes, 0600 config mode, hostile PG/SSL/database/dotenv environment removal, sanitized output, and cleanup after both CLI failure and successful credential emission followed by CA refusal.
  - A copied APPROVED waiver with the copied runner's exact digest reaches only the injected safe CLI boundary. DRAFT, consumed, wrong runner hash, missing acknowledgement, and mixed acknowledgement refuse before credential acquisition.
  - Copied source, bundle hash, and CA drift refuse with the intended boundary. The real waiver is never approved or consumed.

### Manager subscription checkout authorization

- `src/app/api/stripe/checkout-portal/route.ts`
  - Uses canonical `requireManagerRouteUser` after authentication and before request parsing, price resolution, billing-customer creation, or Stripe access.
  - Rejects a missing or mismatched canonical actor with 403.
  - Reuses the guard's service-role client and still binds customer creation and checkout metadata to the authenticated `user.id`.
  - The inspected caller is the existing manager plan-upgrade flow, not role enrollment. Subscription-session idempotency remains outside this correction.
- `tests/integration/stripe/subscription-billing.test.ts`
  - Resident-only and vendor-only canonical denials prove zero customer and Stripe calls.
  - Canonical manager admission preserves hosted paid-plan checkout and pins the billing customer to the authenticated user.
  - A mismatched canonical actor identity refuses before billing or Stripe work.

### Shared inbox composer

- `src/components/portal/portal-inbox-ui.tsx`
  - Below 768px, the composer row may wrap and the existing channel picker moves to a full-width last row. Attachment, textarea/emoji, and send remain together with a usable writing surface.
  - At 768px and above, the incumbent single-row layout remains unchanged.
  - Blue Steel tokens, all controls, scheduling, attachments, safe-area behavior, and existing phone navigation are preserved.
- `tests/e2e/communication-reply-composer.spec.ts`
  - Adds 375/768/1280 checks for a usable textarea, ordinary center click/focus/typing, emoji menu reachability, attachment file-chooser reachability, send enablement/hitbox without submission, and schedule check/uncheck/date-field reachability.
  - No forced click, shrunken touch target, message submit, upload, or provider call is used.

### Waiver and handoff

- `docs/waivers/2026-09-11-production-comms-billing.md`
  - Candidate runner SHA updated only. Status remains `DRAFT - NOT APPROVED, NOT APPLY-CAPABLE, NOT CONSUMED`.
- `docs/plans/2026-09-11-comms-billing-release-correction-1-handoff.md`
  - This durable execution evidence and fresh review request.

## Final identities

- Preparation runner: `cff0016ba1799b75ddb295b83c66f921c56857e5e7d0f675adcd9c73fd91787b`.
- Exact atomic bundle: 67,040 bytes, `c8013155b6cb51792950177cd47b348d51d7ce24df7869a5892ec74bb29541ff`.
- Canonical correction: `229e0699bc0e4685dc8ba2f6380ef9d2358816a1d72415abe7d4adb7a9c49713`.
- CA: `700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7`.
- Corrected fixed runner: 28,474 bytes, `56e88313a0da9b14ef04e4d146392782a79085e80ff04266149e8a6f9be09cc6`.
- New local harness: 12,673 bytes, `06b8548d81650b3f733d2d6a7d8866d6b2be1c94db2e2bf5ac681c32b5795e8b`.
- Runner unit: `59b5abb194aabe28cb24253a17c4235345832a6ba00719a5bc08b3f356831f8e`.
- Harness wrapper: `f074ee0508f0ebeef6f411772c51d423eed3692c80e69cf99e1cecd3441e3f02`.
- Subprocess boundary test: `baca16ce9e692dadee873dcf754d3915019fcd88957474007475b719fa9834ab`.
- Shared inbox composer: `22f1560b1f11c85081c8c7bc2501aa360658dc5b201450f0b6fbc2cc6530220c`.
- Composer browser spec: `93b752e39b56393460ae9e5f925ce7779de3dfba6cffaee9471f88fa751a294d`.
- Checkout portal route: `c9367424b5903b016bc8999036a63c335de9f6a1df7a8f4379700cf9fd22e859`.
- Stripe subscription integration test: `42879c9f2a961434fdb359528e811bcb1f9be53e6ce8003a7e04d0a815f2bb64`.
- Still-DRAFT waiver document: `9b8f208c2e994c5a484c12f87879b6426348cdb9f34e64d0139279f3c4a78e10`.

## Commands and exact outcomes

All listed commands used Node `v22.23.0` and `NODE_OPTIONS=--max-old-space-size=4096` where Vitest was involved. Items 1 and 3 are the final-source behavioral runs; item 2 is an earlier green runner checkpoint retained for chronology.

1. `node scripts/testing/comms-billing-migration-apply-local-harness.mjs`
   - Final exit 0.
   - Fixed runner real-pg commit/readback, auxiliary and catalog rollback, timeout, async disconnect, lost-response no-replay, and TLS rejection passed.
2. `vitest run tests/unit/comms-billing-migration-apply.test.ts tests/unit/comms-billing-migration-apply-local-harness.test.ts tests/unit/comms-billing-migration-apply-subprocess.test.ts --maxWorkers=1 --reporter=dot`
   - Exit 0: 3 files, 23 tests passed.
3. `vitest run tests/unit/comms-billing-migration-apply.test.ts tests/unit/comms-billing-migration-apply-local-harness.test.ts tests/unit/comms-billing-migration-apply-subprocess.test.ts tests/integration/stripe/subscription-billing.test.ts tests/unit/inbox-reply-channel-picker.test.tsx tests/unit/inbox-attachment-chip.test.tsx --maxWorkers=1 --reporter=dot`
   - Exit 0 on the final source: 6 files, 53 tests passed, duration 279.47s under heavy concurrent checkout load.
4. `eslint` over the runner, harness, three runner tests, route/integration test, composer, and browser spec
   - Exit 0 with 12 pre-existing warnings in `portal-inbox-ui.tsx`; no errors. The warnings are outside the corrected composer lines.
5. `node --check` on the fixed runner and local harness
   - Exit 0 for both.
6. `E2E_TESTS_ENABLED=1 playwright test tests/e2e/communication-reply-composer.spec.ts --list`
   - Exit 0; setup plus the corrected Chromium spec collected, 4 total tests in 2 files.
7. Impeccable layout detector over the composer and browser spec
   - Exit 0 with `[]`; no mechanical findings.
8. `git diff --check`
   - Exit 0; no output.
   - The separate scoped `rg '[ \\t]+$'` scan including untracked runner artifacts exited 1 with no output, meaning it found no trailing whitespace.
9. `npx graphify hook-rebuild`
   - Exit 1: npm could not determine an executable to run. No alternate graph engine was installed and no graph artifacts were changed.
10. Local Node hash/status assertion over the runner and real waiver
   - Exit 0: runner hash equals the recorded candidate hash and the waiver status is exactly DRAFT/not approved/not apply-capable/not consumed.

Intermediate failures retained as evidence:

- The first subprocess fixture run failed all 7 cases because macOS `/var` versus `/private/var` path canonicalization prevented the copied runner's direct-entry guard from firing. The fixture now passes a realpath; final 7/7 pass.
- One route integration rerun failed 1 of 11 because the newly added test mock replaced the billing identity export used by the sibling billing-portal route. The mock was narrowed to a partial module mock; the next route run passed 11/11 and the final combined run passed.
- The first full-runner local attempt rolled back because the new exact expected partial-index definition omitted the catalog's `WHERE` clause. Correcting the verifier and negative fixture produced the final real-pg pass. This was an implementation defect, not a relaxed test.

Supporting pre-correction evidence from root remains: full unit exit 0, 1,389 files and 9,754 tests, duration 327.41s. It is not presented as post-correction evidence. No full unit, typecheck, build, or competing compiler was started in this correction session.

## Browser evidence and truthful gap

Root's pre-correction real seeded reproduction remains at `output/playwright/20260911-composer-375.png`: at 375x844 the textarea was 62px wide and its center was intercepted by the emoji control; ordinary clicks passed at 768 and 1280.

The corrected real browser spec was collected but not executed. Other checkouts had active Next/compiler processes, and root explicitly retained ownership of actual browser startup to avoid harness/compiler competition. Therefore 375/768/1280 seeded browser QA, safe-area/native phone confirmation, and a Review URL remain pending. No provider send occurred. The source fix and spec must not be called browser-passed until root runs them.

## Remaining gates and fresh review request

Fresh Astra should review the correction plan, original release review, this handoff, and only the correction files above. In particular it should independently inspect exact catalog comparison, subprocess isolation, real-pg failure classification/no replay, canonical checkout authorization, and phone composer reflow. It should rerun the narrow Node 22 matrix as needed. This is a review request, not a release action.

After review, root still owns stable post-correction full unit/lint/typecheck/build, seeded browser QA at all three widths, Review URL, security/bugbot disposition, and the broader release gates. The current nightly 52 failures were not broadened into this cycle. Exact-SHA staging deployment, staging-scoped credentials, reviewed one-shot staging apply/readback, full staging billing/tour/recovery/browser/handset and invoicer cutover/rollback QA, ship preflight, fresh production preflight, and Akhil's explicit approval of waiver `2026-09-11-production-comms-billing` at runner `56e88313a0da9b14ef04e4d146392782a79085e80ff04266149e8a6f9be09cc6` remain mandatory. Uncertain apply is never retried.

Exact next-session prompt:

> Fresh Astra review correction cycle 1 for the communication billing ASAP release. Work only in `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/3/AXIS-2`. Read the full feature-cycle skill, AGENTS/Akhil instructions, original release plan/review/handoff/root evidence, correction plan, and `docs/plans/2026-09-11-comms-billing-release-correction-1-handoff.md`. HEAD remains `97815a2d459c0bf96e9e80d4f94d29bff7d23fe2` with the pending no-commit merge. Review only the correction files and verify all acceptance criteria, hashes, exact catalog checks, real-pg/TLS/subprocess boundaries, manager authorization, and composer adaptation. No Git, remote, credential, database/provider, deployment, waiver approval, no-mistakes, Linear, or Lavish operations. Record findings with severity and exact references; if sound, return approval to root for broad gates, otherwise write correction cycle 2. The real waiver must remain DRAFT.
