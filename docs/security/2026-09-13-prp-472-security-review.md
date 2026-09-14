# PRP-472 security review - September 13, 2026

Reviewer: `security_review`, independent read-only server review. Result: **No confirmed authorization/exposure regression; one P2 API reconciliation finding requires correction, and acceptance evidence gaps remain below.** This is not a release approval or a claim that missing acceptance cases passed.

## Reviewed boundary

- Worktree: `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/6/AXIS-2`, keeper `akhil/prp-472-inbox-unread`.
- Feature base and current HEAD: `3c997bc4f09ef3b97c80cb559e8909830e164868`; feature edits were uncommitted.
- Integration parents: `8cfe3491372515bb2acd96a346ce688047a83ca6` and `203d5e58f3ad99e6a977d65b1bbdb69115c52711`.
- Inspected the working diff of `src/app/api/portal-inbox-threads/route.ts`; new observation helper, RPC migration, observation and route-contract tests; relevant response-metadata serialization changes in `src/lib/portal-inbox-storage.ts`; and the existing authorization/upsert helpers.
- Inspected `git show --remerge-diff HEAD` and parent comparisons for the assigned route. Its integration version is byte-identical to pinned upstream parent `203d5e58...` (both SHA-256 `3c8f4fb2b5a42f37760223799e2a01a51addc03b98a2c51f73f2e2a79750b182`). There is no manual server-route conflict resolution. Compared with PRP-470 parent, the added folder action retains full ID-count/scope preflight, inbox/edit linked authority, and the SMS-notice rejection before the folder RPC.
- Read root/Akhil instructions, Communication and co-manager contracts, and the PRP-472 plan, safety addendum, upstream addendum, handoff, and independent RPC validation report. Neither `.graphify/graph.json` nor legacy `graphify-out/graph.json` was available in this checkout; pinned source is the evidence.

## Security findings

### P2 - A later RPC failure discards already committed source outcomes

Location: `src/app/api/portal-inbox-threads/route.ts:165-166` (also the retry-query error at `:172` and the outer POST catch). Parent reviewer identified the combined failure path; this reviewer independently confirmed its server half against the safety addendum.

Reproduction: submit two authorized unread sources with matching observations. Let the first `mark_portal_inbox_source_read` RPC commit and return `true`, then return a database/schema/network error for the second RPC. The handler throws, returning only the generic 500 error; the first source remains durably read, but its accumulated successful result is lost. `markPersistedInboxSourcesRead` turns the non-OK response into null, and the caller's blanket failure handling restores unread on all requested sources. An already-read source handled earlier in the loop can likewise be incorrectly treated as unread. The existing tests only fail the first RPC, so they miss the partial commit path.

Impact: the visible unread state contradicts committed server state and a later refresh/reopen changes it again. This is an API correctness and integrity-of-reconciliation defect, not a demonstrated confidentiality breach or unauthorized database write. The safety addendum explicitly permits independent per-source commits but requires partial success to be reported and reconciled honestly.

Correction: preserve confirmed per-source outcomes when a subsequent operation fails, report the remaining failed/unknown sources explicitly, and reconcile the client's success and failure subsets separately. Keep database failures visible as errors; do not turn them into successful reads or add a broad write fallback. Add a two-source regression whose second RPC fails after the first commits, alongside an earlier `alreadyRead` case. Coordinate this with the primary review's client rollback finding.

### Controls that pass source inspection

1. **Batch authorization passes source inspection.** `route.ts:134-155` resolves the authenticated/effective viewer, restricts the action to manager scope, bounds sources to 500, rejects duplicate IDs, and requests linked owner access at `inbox/edit`. The shared scope predicate filters the lookup; returned count and every row's scope are checked before the first RPC. Missing/inaccessible IDs reject the complete batch without returning any member state. The initial query checks explicit scope after retrieval rather than through a database `.eq`, but mismatched scope still fails before mutation or state disclosure. The existing owner/participant scope semantics are preserved.
2. **Observations are SHA-256 fingerprints, not HMAC signatures or credentials.** `portal-inbox-read-state.server.ts:13-26` includes raw durable identity, scope, owner, participant, type, timestamp and complete JSON with recursively ordered object keys and preserved arrays. This matches the safety addendum. Their predictability supplies no authority: the route independently authorizes IDs before interpreting an observation. GET overwrites stored/browser metadata with the actual returned database record ID and fresh observation (`route.ts:88-91`).
3. **Concurrent content is protected.** `route.ts:160-178` never upgrades an old browser observation to a newer snapshot on retry. RPC arguments come from the authorized database row, not browser-owned identity or JSON. The SQL predicate checks owner/participant/type, scope, timestamp and exact JSONB (`migration:12-19`); same-timestamp append/draft/folder mutations therefore defeat an old read. Only `unread` and a strictly advanced timestamp are updated. Trash and malformed/missing folder or non-boolean unread cannot be updated. Schema/RPC errors fail without a generic upsert or folder-write fallback.
4. **Database exposure is appropriately restricted.** The migration uses `SECURITY INVOKER`, `VOLATILE`, an empty search path, fully qualified table/function references, and one transactional revoke/grant sequence (`migration:7-24`). PUBLIC, anon and authenticated lose execution; service_role receives it. Root's separate RPC report records actual catalog state and anon/authenticated denial, as well as long-history and race probes. The migration hash below matches that report; this reviewer did not repeat database calls.
5. **Response metadata is stripped at durable boundaries.** Generic server upserts normalize through `route.ts:24-30,245-247`; supplied top-level `readSources` is removed before building `row_data`. Client upsert/replace serialization and the legacy `persistInbox` replace path remove the field (`portal-inbox-storage.ts:412-424,519-527`). Retaining it in the existing viewer cache does not turn it into authorization. Metadata stripping does not change stored owner attribution or the existing authorization checks.

## Evidence gaps and limits

- **Required permission scenarios are not proven by the new route tests.** `tests/unit/portal-inbox-read-route-contract.test.ts:10-21` mocks linked-owner lookup and effective-user resolution and turns `applyPortalInboxThreadScope` into an identity function. The fake query ignores filters. The test called “mixed authorized IDs” (`:90`) only supplies fewer returned rows than requested. Removing the real scope application, or changing `inbox/edit` to `inbox/read`, would not fail these tests. Add route tests using the real scope/permission helpers or an integration fixture for owner, read-only co-manager denial, edit co-manager success, unrelated owner, mixed accessible/inaccessible batch, and admin effective viewer. Existing scope-string tests help with the helper's shape but do not prove the new route composition. The handoff's phrase “route authorization” should be read with this limit.
- **Route retry/CAS behavior lacks direct behavioral coverage.** Current route tests cover stale observations before RPC and RPC errors, but not successful acknowledgement, first CAS miss with an intervening same-timestamp change, second-attempt bound, wrong stored scope, or forbidden client metadata on a generic upsert. Root's SQL probes establish the database operation's guard, not the complete route composition. The source implementation appears conservative; these are acceptance-evidence gaps, not demonstrated security bypasses.
- Grant revocation after the one batch authorization lookup is not serialized with all per-source RPCs. This accepted limitation is recorded in the plan/handoff. Stored identity changes still defeat CAS. Independent commits are allowed, but their loss from the response on a later error is the P2 finding above; no batch-wide transaction is required to fix it.
- Shared owner/participant authorization is inherited from the existing mailbox write path. This review does not claim that manager scope itself is a manager-role gate, nor audit all historical inbox write permissions.
- UI selection, native member identity, viewer-generation reconciliation, visibility, and collapse completeness belong to the parallel primary review; this report only inspects the response stripping integration relevant to server trust.

## Snapshot fingerprints and validation attribution

SHA-256 of reviewed working files:

```text
e1c2167dc7ebdd1bc2e59bfd06f6d07f72a4acfdc4177e8e57f8bafb392a268e  src/app/api/portal-inbox-threads/route.ts
5d628c0829160cd6fcd50e957dfd8369267f66b17b1e9f764d14e1f85b7f5c11  src/lib/portal-inbox-read-state.server.ts
8a6007c229d637f3eb4d6091650ddb8c546a7f5dee353abcb157e4bd99f5bad6  supabase/migrations/20260913170000_mark_portal_inbox_source_read.sql
e4ac40a22778c8393152fa856f47a236b9d46a67a0c5184c81a6f3675df96ab0  tests/unit/portal-inbox-read-observation.test.ts
e8ccc3891929f0d0df3df64d19ecb78f3dd43abb8b1a4440986af703d385e7e8  tests/unit/portal-inbox-read-route-contract.test.ts
```

No test runner, lint/build, browser, database, provider, no-mistakes, commit, push, staging or production operation was performed by this reviewer. Prior executable results are attributed to `docs/plans/2026-09-13-prp-472-rpc-validation.md` and `docs/plans/2026-09-13-prp-472-handoff.md`; the root owns serial broad validation. This report is the only artifact written.
