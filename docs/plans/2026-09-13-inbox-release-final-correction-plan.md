# Inbox release final review correction plan

Date: 2026-09-13. Candidate keeper `akhil/prp-472-inbox-unread`, HEAD `276e1e40a0a9f3f63bee3a87b4fabbbd9edaf54b` plus frozen working delta; review base `75d711053085e340072c605bcb96eaa9416ef87e`. Root's 33-file freeze aggregate is `8c05f33c0822e68e81b7e24e4ae8ec90aa7f43fae21855dea7fb265c6928e0aa`.

This is a bounded correction under Akhil's resumed test-and-release request. Root coordinates new source ownership and refreshes the freeze. No no-mistakes, production writes, provider sends, Git mutation or deployment by implementers. Preserve the existing release ladder and separately reviewed production prerequisite authority.

## R1 - explicit initial inbox retry after SMS authorization refusal

`src/components/portal/pro-unified-inbox.tsx:345` refuses every load after a current-viewer 401/403 sets the polling latch. The initial error component at line939 calls `loadInitialList` without clearing the latch. Therefore the actual Retry button never makes a second SMS request even after same-viewer access recovers, leaving the entire initial list hidden.

Fresh final reviewer reproduced this in the actual mounted component by adapting the retained legitimate-A-auth-halt test to click Retry without switching identities. Private artifact `/private/tmp/axis-inbox-release/final-review-probe/retry.test.tsx`, output `result.log`: exact-file Vitest run exit1, expected SMS calls2 but received1; the error alert persists. This is a reproduction failure, not a passing product test.

Add a small explicit-retry callback that clears `smsPollHaltedRef.current` and `setSmsPollHalted(false)`, then returns `loadInitialList()` so Button owns its promise. Wire only the explicit Retry action to it. Do not clear the latch in automatic loads or timers. No cache invalidation is necessary: the existing SMS coalescer retains only in-flight/queued promises, not settled responses. Preserve viewer and initial-load generations and unforced shared loaders.

Retain mounted behavioral tests, preferably in `tests/unit/inbox-initial-loading-readiness.test.tsx`: each of401/403 initially hides rows, same viewer explicit Retry makes exactly one further request, successful200 reveals rows; another refusal remains an error and does not trigger timer/refocus retries; a later explicit Retry still works. Keep existing late-A401/403 and A-to-B auth-latch tests passing.

## R2 - reject a column-limited recovery write trigger

The additive recovery migration claims exact existing-trigger equivalence but does not check `pg_trigger.tgattr`. A pre-existing `BEFORE INSERT OR UPDATE OF <column> OR DELETE` trigger may share function, event mask31 and every currently checked field while failing to guard updates to other columns. Require an empty column attribute vector for the write guard; reflect that contract in catalog probes and retained SQL coverage. Independent security reviewer confirmed this with the actual migration in PGlite, exit0: the narrowed guard was accepted with event mask31 and tgattr=3.

Use an executable PGlite regression that creates the narrowed same-name trigger with the actual recovery function and asserts the migration fails closed and leaves no partially installed companion trigger. Retain normal fresh install, double apply, exact lifecycle, prerequisites and rollback tests. Update `scripts/testing/tour-followup-recovery-guards-probe.sql` to verify full-column write coverage. Do not change historical migrations, recovery functions, grants, RLS, data or manifest policy.

## Execution and verification

Fresh Sol-medium coordinates Terra source/migration work and Luna tests in explicit non-overlapping ownership. Review source and test diffs before handing back. Run focused readiness, SMS polling/client, observed-read/controller/reconciler and recovery matrices under Node22 with one worker; root owns full unit/lint/build and local E2E. No concurrent broad runners. UI fix requires real DEV failure/retry browser evidence with actual authenticated payloads and bounded response interception, no provider sends. Root may rerun the corrected rollback-only staging recovery rehearsal after review; delegates do not execute remote SQL.

Save a handoff with exact commands/exits, behavioral evidence and source fingerprints. Root launches fresh final Astra/security/Bugbot review on the corrected frozen candidate. The current broad checks are on the prior freeze and cannot certify these future edits.
