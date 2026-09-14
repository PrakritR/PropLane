# Inbox release security acceptance re-review

Date: 2026-09-13. Independent security acceptance review for Akhil.

**No unresolved security findings in the reviewed source freeze.** Prior S1 remains corrected, and the final correction resolves S2. This decision supersedes the source-level changes-required disposition in `docs/security/2026-09-13-inbox-release-security-review.md` for the exact inventory below. It is not deployment approval or a claim that outstanding release QA is complete.

## Scope and provenance

- Worktree: `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/6/AXIS-2`.
- Keeper: `akhil/prp-472-inbox-unread`.
- Base: `75d711053085e340072c605bcb96eaa9416ef87e`.
- HEAD: `276e1e40a0a9f3f63bee3a87b4fabbbd9edaf54b` plus frozen working delta.
- Full 33-file source freeze: `7432b0cc36d65cd4822aa16295e368812194258ad4b4d7fe35b64f11df263ce8`.
- Every current file hash and the aggregate were independently recomputed immediately before writing this report. The aggregate is SHA-256 over the sorted, compact JSON path-to-hash dictionary, as used by root's freeze tool. Documentation is outside the source freeze.

Read repository and Akhil instructions, the prior source security review, final correction plan/handoff, Communication contract, and separate production-prerequisite review. Graphify query exited 1 because its graph file was absent; no rebuild or graph mutation was attempted. This is an acceptance re-review of the prior 33-file assessment: all 33 bytes were verified, the five changed files were examined, and the authorization route, read RPC/observation helper, read controller, and viewer-scoped SMS helpers were rechecked against the prior security conclusions. This report does not claim a new line-by-line audit of every unchanged test or every historical migration.

Exactly five files differ from the prior security freeze: the unified manager inbox, its initial-readiness tests, recovery guard migration, rollback probe, and recovery SQL tests. The remaining 28 files match the prior independently reviewed inventory, including the S1 correction.

The reviewer made no source, Git, remote database, provider, browser, server, or deployment changes. No broad runner or no-mistakes pipeline was invoked. The sole repository write is this report. One small, isolated in-memory PGlite catalog probe ran against the actual migration.

## Prior findings and correction acceptance

**S1, P2: older failed envelopes replacing newer confirmed read truth - remains resolved.** `src/lib/portal-inbox-read-operation.client.ts` retains the correction that treats `failed` outcomes as unknown, excludes them from confirmed updates, removes any conflicting duplicate confirmation, and withdraws only the operation's speculative overlay. It continues to preserve individually valid partial successes. Its SHA-256 is `60c1c55b16b53cd8ab4727cef843b55a970c7732d4da5bfabc091d7d660647b3`; its retained test hash is `c5ed6cfade5fa5b5713977a1bb7928f4701d31fe5ac5d7c0eaa2c7c0ae0eb194`, both unchanged. The actual controller/reconciler tests still cover both settlement orders and failed reopen after partial success. The prior security review's independent mixed failed/changed-envelope reproduction and post-fix probe remain applicable to those identical bytes. They were not represented as a newly rerun browser or full-suite check here.

**S2, P2: column-restricted UPDATE guard accepted as exact - resolved.** Both existing-trigger branches of `supabase/migrations/20260913173000_tour_followup_recovery_guards.sql` now reject nonempty `pg_trigger.tgattr::text`. The rollback probe enforces and prints the same field. Function OIDs, zero-argument trigger return type prerequisites, event masks 31/9, normal enabled state, absent WHEN predicate, noninternal identity and no constraint identity remain checked. Fresh installation still creates full INSERT/UPDATE/DELETE coverage and the AFTER DELETE capture; no recovery function, grant, RLS, data, or restore policy is changed.

The retained executable PGlite case installs historical recovery functions, creates the actual same-name `BEFORE INSERT OR UPDATE OF archived OR DELETE` trigger, executes the actual new migration, expects its conflict exception, rolls back, and asserts only the original narrowed trigger remains with `tgattr='3'`. Existing tests continue to cover fresh/double apply, missing prerequisites, a later companion conflict that rolls back an earlier creation, held-write rejection, captured delete, retained completion, and rollback fixture cleanup. This is behavioral SQL coverage, not a source-string assertion alone.

Independent check in this review: Node 22.23.0 with an isolated in-memory PGlite database executed the exact current migration. A same-name narrowed trigger with mask 31 and `tgattr='3'` was rejected; after rollback it was unchanged and the companion was absent. Removing that synthetic conflict and applying twice produced the exact masks 9/31 and empty attribute vectors. Exit **0**. This small check used inert zero-argument trigger bodies to isolate catalog behavior; lifecycle behavior is covered by the implementation owner's historical-function tests and root's remote rehearsal, not by this catalog probe.

**Final overall-review R1: explicit same-viewer Retry - accepted with no new security regression found.** The new `retryInitialList` only clears the SMS client pause on the visible initial Retry action, then returns the existing loader promise. Initial/background loaders do not automatically clear the pause. Server session authorization, viewer epochs, initial-load generations, and shared unforced requests remain in force. Retained mounted tests cover each initial 401/403 followed by successful same-viewer retry, another refusal remaining paused through refocus with no polling timer, and a later successful explicit retry. The correction grants no server privilege and does not turn an authorization refusal into successful readiness.

## Security invariants rechecked

The manager read route resolves the authenticated effective viewer, requires the supported manager storage scope, bounds/deduplicates identifiers, derives linked-owner inbox/edit grants, and verifies the full source set is visible and in scope before writes. Observations are generated from actual authorized rows and replace stored metadata. The observation is a stale-state token, never authority. The SQL CAS still compares durable identity, timestamp and complete JSON, requires unread eligible folders, and changes only unread plus a monotonically advanced timestamp. It remains SECURITY INVOKER with empty search path and execution revoked from PUBLIC/anon/authenticated, granted only to service_role. No authorization, RLS, grant, content, ownership, attachment, or folder-write broadening was introduced by the five-file correction.

Viewer-specific SMS storage/coalescing and stale-response protections remain intact. Explicit native bindings, ambiguous fallback refusal, visible-pane acknowledgement, and operation-owned reconciliation retain the prior review's unchanged source assessment. The final correction does not add provider calls or new message transport.

The recovery probe retains its collision-refusing synthetic fixture, 5-second lock timeout, 15-second statement timeout, ordinary-write test after clearing the internal snapshot marker, exact captured phase-2 hold assertion, retained completion, and rollback cleanup. Existing recovery snapshots can acquire broad table locks; rollback safety does not eliminate operational blocking. No historical recovery-state repair or recreatable/never-restore policy expansion is included.

## Execution evidence and release boundary

The final correction handoff reports Node 22 focused validation, separately attributed to the implementation owner: 9 inbox files / 88 tests, exit 0; 3 recovery-related files / 41 tests, exit 0; scoped ESLint exit 0. Those results include the exact five correction hashes in this freeze. The reviewer inspected the new retained behaviors and independently ran the catalog check above; no full unit/lint/build or browser result is claimed as reviewer execution.

Root owns refreshed broad validation, real DEV failure/Retry browser evidence, required local portal E2E, fresh overall/Bugbot reviews, exact deployed staging candidate and QA, preflight and production/TestFlight checks. Root relayed the corrected actual staging rollback rehearsal after this source assessment: exit 0, exact migration DO body installed twice inside the rollback wrapper, all SQL/probe assertions retained, and all seven final fixture-count columns zero. A separate lifecycle readback exited 0 and the full before/after catalog was exactly equal. Migration SHA-256: `0848ed305b3fa742f1b16e75133931718c7c05b10f7b4df760d7ded2467d53a4`; execution wrapper SHA-256: `bbbcf475863f7dbbc7395750f4c7211d712edfd1e0946704d94f4d4eb950414e`. This execution evidence is attributed to root; this reviewer made no remote call. It establishes the bounded rollback rehearsal, not deployed staging feature QA or the other release gates.

Root subsequently committed the source candidate as `542d11ca0`; it was previously reviewed as `276e1e40a0a9f3f63bee3a87b4fabbbd9edaf54b` plus working delta. All 33 file hashes and their aggregate were independently reverified unchanged after that relay. The source security acceptance therefore carries to that commit's identical frozen files.

The four older production migration gaps remain governed by `docs/security/2026-09-13-prp472-production-prerequisites-review.md`. This source acceptance neither expands their scope nor authorizes applying them. Preserve the bounded target/backup/fail-closed apply/verification and explicit authorization requirements. Do not apply every pending migration, enable automated messaging, mutate locked listings, alter retention policy, or repair historical recovery records on the strength of this report.

## Exact frozen inventory

```text
2fd90572788bd2c7926bad55f57f4c5c4887fcf855c1d09a77e46706e991d158  scripts/testing/tour-followup-recovery-guards-probe.sql
2a971eb597b05c9514b3631ef769c03d8c6d0a2cfff2b12050dde3f79dfe15c0  src/app/api/portal-inbox-threads/route.ts
eea7d384a39695e42e9ffd8648ae231e8290fa4808d42c94ca88012bb22c6a03  src/components/portal/communication-inbox-initial-state.tsx
a566a23f8817a4984a72e1897c937277d06ceab4518a420ee18d41a03eca245b  src/components/portal/pro-communication.tsx
3efc8144b1817e8c3d3dcce6114d4e1bf19be972c92ecdeae80af8489f3f87cc  src/components/portal/pro-resident-detail-inbox.tsx
f1c516cf1f00e73b5ea7490f98cba711844b9b0978540637647888e44ab3968d  src/components/portal/pro-sms-panel.tsx
50d543111bf8043de8fd758b23cb29f11536682ea1f35a584a3998b217ded7e1  src/components/portal/pro-unified-inbox.tsx
a7b1c02a632af82fced2451bc2f51bf49fad75033bc997773737d657f18a8ee2  src/components/portal/resident-communication.tsx
214057f802c7b2ced8e04ff42df2413e80f9af2bffb63ec4dc047af23e8e7149  src/lib/manager-applications-storage.ts
82e6be042430d666c719042680a9484d342c6b9a7608899732babb60c4d318a4  src/lib/manager-sms-conversations-client.ts
bdd12335fa1e62c009034a6dabd7c98ede40f88a54083200773cea1d237fbccc  src/lib/manager-sms-opened.client.ts
60c1c55b16b53cd8ab4727cef843b55a970c7732d4da5bfabc091d7d660647b3  src/lib/portal-inbox-read-operation.client.ts
5d628c0829160cd6fcd50e957dfd8369267f66b17b1e9f764d14e1f85b7f5c11  src/lib/portal-inbox-read-state.server.ts
717bbb015ff3a9746f1a308c4e1547641995839123735f3d8ec781a3bcfc1bc9  src/lib/portal-inbox-storage.ts
b9ab88bb6d05157bc035ba45ec9919937d1c441aedfaa15e64f4d24030e80634  src/lib/unified-inbox-merge.ts
8a6007c229d637f3eb4d6091650ddb8c546a7f5dee353abcb157e4bd99f5bad6  supabase/migrations/20260913170000_mark_portal_inbox_source_read.sql
0848ed305b3fa742f1b16e75133931718c7c05b10f7b4df760d7ded2467d53a4  supabase/migrations/20260913173000_tour_followup_recovery_guards.sql
c9c02f11093e389c7da09dba6d2c4d9f522ecb1857e29330f66fc2ed9c78e835  tests/unit/communication-status-behavior.test.tsx
ea4553dd96ef89f93ec80efeac85e1a6702a47434c636f68b35405ce0fb3caad  tests/unit/inbox-initial-loading-readiness.test.tsx
72fbec02ad0c9a47f39f91d1430e1f7f3dbfe9478437914f1cf1556e5a818fef  tests/unit/manager-sms-conversations-client.test.ts
6f5147a95ff166980ec75ca56db075a347e892ace13abe381da1bd2c2dbfac03  tests/unit/manager-unified-inbox-read-integration.test.tsx
b5eb7b8111c85209bf789220600268ce9884bf2dbb4cff568c8862b9f3eba813  tests/unit/portal-inbox-co-manager-grants.test.ts
e4ac40a22778c8393152fa856f47a236b9d46a67a0c5184c81a6f3675df96ab0  tests/unit/portal-inbox-read-observation.test.ts
c5ed6cfade5fa5b5713977a1bb7928f4701d31fe5ac5d7c0eaa2c7c0ae0eb194  tests/unit/portal-inbox-read-operation.test.ts
f8c237dabddae78cf93c9fb025ee58c0ab593b4a53b9644da08745c8c962fe2a  tests/unit/portal-inbox-read-route-contract.test.ts
acf3634c4bd05cd51d710156e4dbd82d50a3a0a7f7860f9bf3049cd6f23c5f8c  tests/unit/portal-inbox-read-storage-contract.test.ts
94e7b05e213cda875af6754126d01fef06cc1cb7827483b9be3d6b430f0005a5  tests/unit/portal-inbox-scope-effective-viewer.test.ts
aec43d8b444bce2231cddd03b1e5305299d6dd6832e67b5b45f8336d6a623f58  tests/unit/pro-resident-detail-read-behavior.test.tsx
6c28b89781bfdddd4282f56645e05f66e92dfaf64113aedd0e10b01fe160def5  tests/unit/pro-sms-panel-opened-retry.test.tsx
4497035e8c9933cd768bbe255908358544591e02e5011a50ba0ea32ba3172b6e  tests/unit/resident-conversation-inbox.test.tsx
23a88eebc3d63b81618645f745f5b06b985bbfe8e74ed64f3100b9563e59cf57  tests/unit/tour-followup-recovery-guards-sql.test.ts
a42cf7792df04cdb2a328cf089a7b53dfa4a8fa7af1d360f3c645b27528c4d63  tests/unit/unified-conversation-inbox.test.tsx
2dc1d0f740de83e2b3fc5cebd103f427ff18f2de3af8190f12f85563461228bd  tests/unit/unified-inbox-sms-poll.test.tsx
```
