# PRP470/472 final source security review

Date: 2026-09-13. Independent security review for Akhil. **CHANGES REQUIRED: S2 remains unresolved in the frozen candidate.** One P2 read-state integrity finding (S1) was reproduced, corrected by the implementation owner, and independently rechecked. A second P2 failure of the recovery migration's exact-trigger check (S2) was reproduced before review closure. This is a source security decision, not release approval or a claim that all QA gates have passed.

## Scope and provenance

- Worktree: `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/6/AXIS-2`.
- Branch: `akhil/prp-472-inbox-unread`.
- Comparison base: `75d711053085e340072c605bcb96eaa9416ef87e`.
- Git HEAD: `276e1e40a0a9f3f63bee3a87b4fabbbd9edaf54b`.
- Reviewed the base-to-working-tree diff under `src`, `tests`, and `supabase`, plus the new recovery migration, rollback SQL probe, and recovery SQL test. The controller and its test contain the final uncommitted security correction after HEAD. The exact 33-file inventory is below; every file was rehashed against root's freeze before this report.
- Root's frozen aggregate: `8c05f33c0822e68e81b7e24e4ae8ec90aa7f43fae21855dea7fb265c6928e0aa` from `/private/tmp/axis-inbox-release/source-freeze.json`. This report does not cover subsequent source changes.
- Read repository/Akhil instructions, the canonical original-checkout feature-cycle document, Communication and recovery contracts, PRP470/472 plans and safety/release addenda, recovery release plan/handoff, and `docs/security/2026-09-13-prp472-production-prerequisites-review.md`. The pool has no `.graphify/graph.json`; source and scoped documents were used. No graph rebuild was performed.
- No source edit, remote database/network mutation, persistent database change, browser/server operation, Git mutation, full test run, provider call, or no-mistakes invocation was performed by this reviewer. The sole repository write is this report. Read-only Git inspection, small in-memory actual-source Node probes, and one isolated in-memory PGlite migration reproduction were used.

The four older missing production migrations remain governed by the separate prospective prerequisite review. This review does not expand their implementation or authorize their application.

## Finding and closure

### S1 - P2: an older valid failed envelope could overwrite newer confirmed read truth - fixed

At HEAD, `src/lib/portal-inbox-read-operation.client.ts:106` placed individually well-formed `status:"failed"` outcomes into the confirmed-state map. However, `src/app/api/portal-inbox-threads/route.ts:188` constructs `failed.unread` from the record captured before the failed RPC. That value has no authority over a later success.

Concrete reproduced sequence using the real controller and real `reconcileObservedInboxReadRows`:

1. Two email aliases share one explicit native binding. Older operation observes source A at A1 and source B at B1.
2. A refreshed projection retains A1 and revises B to B2; a newer A1/B2 operation begins.
3. The newer operation returns `read,false` for both and both source/aggregate unread flags become false.
4. The older operation returns `[{id:A,status:failed,unread:true},{id:B,status:changed,unread:true}]`.
5. Before correction, unchanged A1 matched its alias's complete source set, so the old failed result restored A unread=true and the aggregate badge. B2 remained protected. Overlay ownership did not prevent overwriting confirmed truth.

This was a client read-state integrity bug. It did not mutate server message content or demonstrate unauthorized mailbox access. Root was notified promptly and routed the correction through the existing implementation owner.

Final code at `src/lib/portal-inbox-read-operation.client.ts:109` treats failed outcomes as unknown: it excludes them from confirmed updates, rejects a duplicate successful result for that same source, withdraws only the operation-owned overlay, and retains successful outcomes for other sources. The route's failure payload remains compatible. Retained tests at `tests/unit/portal-inbox-read-operation.test.ts:318` cover both settlement orders; the existing real-reconciler partial-success test remains.

Independent verification: Node read the current TypeScript files, transpiled the actual controller and exact reconciliation function in memory, and drove the original mixed failed/changed envelope in both orders. Final exit 0: both sources unread=false, aggregate=false, zero overlays, pending map empty, exactly one failure notification. All 33 source hashes matched the freeze immediately before this final probe. The earlier identical sequence reproduced the defect before the correction. These are focused behavioral probes, not browser or full-suite evidence.

### S2 - P2: the recovery installer accepts a column-restricted UPDATE guard - unresolved

`supabase/migrations/20260913173000_tour_followup_recovery_guards.sql:43` checks an existing trigger's name, function, event mask, enabled state, arguments, predicate and constraint identity, but omits `pg_trigger.tgattr`. The rollback probe's matching catalog predicate also omits it. PostgreSQL encodes the UPDATE column restriction separately from the event mask.

Concrete local reproduction, using PGlite and the actual frozen migration, exit 0:

```sql
create trigger account_recovery_write_guard
  before insert or update of archived or delete
  on public.manager_tour_followup_controls for each row
  execute function public.account_recovery_write_guard();
-- Execute the actual new migration unchanged.
-- It succeeds. The existing guard has tgtype=31 and tgattr='3'.
```

The setup used an isolated in-memory table and zero-argument trigger functions. No remote schema was changed. A column-restricted guard does not fire for updates naming only other columns, such as `manager_user_id` or `conversation_key`. Accepting it as the required full write guard violates the explicit fail-closed drift contract and can allow retained controls identity to change without the intended lifecycle check.

The observed staging controls table has no existing custom triggers, and production does not yet have the controls table, so this finding does not invalidate the already recorded absent-trigger rollback rehearsal or claim a current live bypass. It does prevent unconditional clearance of the migration's existing-trigger path.

Required bounded correction: require an empty `tgattr` in the migration's existing-trigger comparison and in the probe's exact catalog assertion/output. Retain a behavioral PGlite case with the column-restricted same-name guard above: migration must fail and roll back without adding capture or modifying the conflicting guard. Existing exact/idempotent catalog tests should assert empty `tgattr`. Preserve all functions, grants, restore policy and data. Rehash the revised migration/probe/test and rerun focused checks plus the bounded staged rollback rehearsal. Root and the fresh final reviewer were notified; implementation is owned by root's correction session.

## Security assessment

**Authorization and CAS.** `markRead` authenticates through the existing effective-viewer resolver, accepts only manager storage scope, bounds and deduplicates source identifiers, derives linked owners with inbox/edit access, and verifies every requested source is visible and in scope before any mutation. A mixed unauthorized/missing batch performs no writes. The action deliberately preserves the existing participant-email branch in `applyPortalInboxThreadScope`; this is not a new manager-role-only authorization model. Admin preview uses the effective identity rather than arbitrary request-owned owner fields. Existing grant-normalization tests cover empty permission maps and read versus edit access.

The server creates observations from actual authorized records and overwrites stored observation metadata. SHA-256 covers durable identity, timestamp and canonical full row JSON. The hash is a stale-state check, not a credential. RPC inputs come from the authorized database row. The SQL function is SECURITY INVOKER, has an empty search path, revokes PUBLIC/anon/authenticated execution, and grants service_role only. It checks manager scope, owner, participant, type, timestamp and full JSON equality, requires an unread non-trash row, then changes only unread and a monotonically advanced timestamp. Same-timestamp content edits therefore prevent a match. It has no fallback to whole-row upsert, broad folder writes, or URL-encoded history equality. Existing RLS/grants are not broadened.

**Failure and partial results.** Authorization failures reject the batch; runtime per-source failures can coexist with earlier committed reads. The client validates source IDs, statuses, boolean state and cardinality; malformed envelopes cannot masquerade as success. The corrected controller preserves valid partial confirmations while unknown outcomes only remove their own speculation. Reconciliation requires exact current observations and completeness, so changed sources and archived rows are not rewritten from an older snapshot. No body, attachment, folder, draft or ownership value is restored from a stale client row.

**Visibility, cache and identity.** Initial readiness depends on successful enabled source completion, not cached rows or a settled failed promise. Cache publication and retained callbacks check viewer/generation identity, including A-B-A transitions; stale 401s are guarded before the session latch is updated. The combined pane derives visible email bubbles and read candidates from the selected authorized snapshot. Explicit native binding sets outrank email fallback; unresolved explicit bindings do not guess by phone/name, and an unbound fallback must be unambiguous. Each resolved native source is rendered before its inbound IDs are opened. Hidden document/mobile panes defer acknowledgement. Device-local SMS receipts use viewer-specific keys and do not import the old unscoped store. The mounted-panel correction reaches the durable helper on explicit reopen even when volatile membership already contains the ID; selection/signature guards bound retries and notifications. No new message transport or external storage access is introduced.

**Recovery guard migration and rehearsal.** The additive migration targets only the exact public controls table and two existing zero-argument trigger functions. It requires trigger return types and validates existing same-name trigger function OIDs, event masks 31/9, normal enabled state, zero arguments, no WHEN predicate, noninternal status and no constraint identity. Detected conflicts abort its transaction. However, S2 shows that the current comparison can silently accept a different column-restricted same-name trigger, so its exactness is not yet sufficient. It does not change functions, data, columns, ownership/restore policy, RLS or grants. Existing archived generations remain protected; this does not repair previously stuck recovery requests or broaden the recreatable allowlist.

The rollback probe refuses to reuse its hard-coded synthetic identity/key, takes a real snapshot/hold through existing functions, clears the internal snapshot marker before exercising ordinary writes, demands a held-write rejection, verifies exactly one recoverable phase-2 captured delete hold before finalization, requires retained state, and asserts no fixture/record/hold leakage after rollback. PGlite coverage executes the actual migration/probe and checks missing prerequisites, drift rejection and idempotence. The probe's real recovery snapshot takes broad public-table locks, so rollback safety is distinct from operational blocking; root's rehearsal retained 5-second lock and 15-second statement limits.

## Evidence and remaining QA limits

- Implementation-owner final handoff reports focused inbox validation: 8 files / 74 tests, exit 0, and scoped ESLint exit 0. This reviewer read the retained tests and independently ran the two focused actual-source race cases above, but did not rerun the suite.
- Recovery-owner handoff reports 3 files / 40 tests, exit 0; scoped ESLint and diff check exit 0. Migration, test and probe final hashes match that handoff.
- Root's `docs/plans/2026-09-13-prp-472-release-validation.md` records the actual staging rollback rehearsal exit 0 with the exact migration DO body applied twice inside the probe transaction. Final auth/profile/role/control/request/record/hold fixture counts were zero. Root additionally compared full pre/post lifecycle JSON and found it equal, including still-absent custom controls triggers. No ledger or permanent DDL remained. This execution evidence is attributed to root; the reviewer made no remote call.
- The inbox handoff records real DEV desktop/mobile visibility, read/reload and localStorage-failure browser QA. It is scoped behavioral evidence, not proof of the final deployed staging candidate.
- S2 requires a narrow migration/probe/test correction and a fresh source freeze/review. The separate overall reviewer also reported an explicit UI retry issue; that is covered in its correction plan rather than duplicated here.
- At review closure, root had started the final full unit run. Final lint/build/typecheck, required local portal E2E, fresh overall review/Bugbot, exact deployed staging SHA and feature QA, production schema backup/target/apply verification, ship preflight, and production/TestFlight checks remain release-owner gates as applicable. This report does not mark them passed.
- Production still requires the separately reviewed bounded prerequisite apply path and authorization. Do not replay all pending migrations or assume this report authorizes unrelated production mutations, automatic messaging, retention-policy changes, or historical repairs.

## Exact frozen inventory

SHA-256 of each file, verified from the working tree. Documentation/handoffs are contextual evidence and are not included in this source freeze.

```text
a65f601e839c2740e296ded12e518b783c20044e427dce5382a492845bd33b0d  scripts/testing/tour-followup-recovery-guards-probe.sql
2a971eb597b05c9514b3631ef769c03d8c6d0a2cfff2b12050dde3f79dfe15c0  src/app/api/portal-inbox-threads/route.ts
eea7d384a39695e42e9ffd8648ae231e8290fa4808d42c94ca88012bb22c6a03  src/components/portal/communication-inbox-initial-state.tsx
a566a23f8817a4984a72e1897c937277d06ceab4518a420ee18d41a03eca245b  src/components/portal/pro-communication.tsx
3efc8144b1817e8c3d3dcce6114d4e1bf19be972c92ecdeae80af8489f3f87cc  src/components/portal/pro-resident-detail-inbox.tsx
f1c516cf1f00e73b5ea7490f98cba711844b9b0978540637647888e44ab3968d  src/components/portal/pro-sms-panel.tsx
c2c67c64a4a1f024e8ebc032de011de9f0d152bd22bbe5eb7f4296d077dd183c  src/components/portal/pro-unified-inbox.tsx
a7b1c02a632af82fced2451bc2f51bf49fad75033bc997773737d657f18a8ee2  src/components/portal/resident-communication.tsx
214057f802c7b2ced8e04ff42df2413e80f9af2bffb63ec4dc047af23e8e7149  src/lib/manager-applications-storage.ts
82e6be042430d666c719042680a9484d342c6b9a7608899732babb60c4d318a4  src/lib/manager-sms-conversations-client.ts
bdd12335fa1e62c009034a6dabd7c98ede40f88a54083200773cea1d237fbccc  src/lib/manager-sms-opened.client.ts
60c1c55b16b53cd8ab4727cef843b55a970c7732d4da5bfabc091d7d660647b3  src/lib/portal-inbox-read-operation.client.ts
5d628c0829160cd6fcd50e957dfd8369267f66b17b1e9f764d14e1f85b7f5c11  src/lib/portal-inbox-read-state.server.ts
717bbb015ff3a9746f1a308c4e1547641995839123735f3d8ec781a3bcfc1bc9  src/lib/portal-inbox-storage.ts
b9ab88bb6d05157bc035ba45ec9919937d1c441aedfaa15e64f4d24030e80634  src/lib/unified-inbox-merge.ts
8a6007c229d637f3eb4d6091650ddb8c546a7f5dee353abcb157e4bd99f5bad6  supabase/migrations/20260913170000_mark_portal_inbox_source_read.sql
9f9bc0e0b3e7059e88b60adc27736615ee45eaf71ad964404931fda77d29be14  supabase/migrations/20260913173000_tour_followup_recovery_guards.sql
c9c02f11093e389c7da09dba6d2c4d9f522ecb1857e29330f66fc2ed9c78e835  tests/unit/communication-status-behavior.test.tsx
1094d08a91e66631803cb30d8b91813bee484f80ea8c5b3886cf01b969b318ee  tests/unit/inbox-initial-loading-readiness.test.tsx
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
d9ccc5acf8fe47d4b96b1955bcf26ac5711adb056a8e18237b2661f86e0882ae  tests/unit/tour-followup-recovery-guards-sql.test.ts
a42cf7792df04cdb2a328cf089a7b53dfa4a8fa7af1d360f3c645b27528c4d63  tests/unit/unified-conversation-inbox.test.tsx
2dc1d0f740de83e2b3fc5cebd103f427ff18f2de3af8190f12f85563461228bd  tests/unit/unified-inbox-sms-poll.test.tsx
```
