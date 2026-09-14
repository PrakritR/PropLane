# PRP-472 correction 1 security review - September 13, 2026

Result: **Server source controls PASS; correction acceptance BLOCKED by one P2 permission-test defect.** No confirmed new unauthorized write or confidentiality regression was found. The original server partial-success finding is corrected. This report does not approve release or attest to client/UI correctness.

## Reviewed boundary

- Independent read-only server review of `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/6/AXIS-2`, keeper `akhil/prp-472-inbox-unread`, HEAD `3c997bc4f09ef3b97c80cb559e8909830e164868` plus frozen uncommitted correction source.
- Read root/Akhil instructions, the Communication and co-manager contracts, correction plan/handoff, safety addendum, and initial security review. User instructions keep resident scheduled compose prohibited, empty permissions deny-all, and staging mandatory regardless of the checkout's temporary exception language.
- Inspected the inbox API, server observation helper, unchanged RPC SQL, durable metadata serialization, actual scope/effective-session/co-manager permission helpers, and relevant route/observation/storage test source. No graph existed at `.graphify/graph.json`; source inspection supplies the evidence.
- No source edits, test execution, browser, database, provider, no-mistakes, git mutation, Linear action, deployment, or production/staging operation. This report is the only artifact written. Root owns executable validation; independent DEV SQL results remain attributed to the existing RPC validation report.

## Open finding

### P2 / Medium - The admin permission test authorizes access that the actual helper denies

Locations: `tests/unit/portal-inbox-read-route-contract.test.ts:21`, `:24`, and `:170-176`. Actual contract: `src/lib/portal-inbox-thread-scope.ts:18-25` and `:63-70`.

The test mock sets `allowedOwnerIds = null` whenever `user.role === "admin"`, allowing every database row. Its purported effective-admin scenario supplies actor `admin-1`, a manager-scope row owned by `unrelated-owner`, and expects a successful write. It never resolves an effective target because `resolveInboxScopeUser` is replaced with a preselected context.

Proof from the actual filter: for actor `admin-1` with no participant email or linked grant, the predicate is `owner_user_id.eq.admin-1,scope.eq.admin`. The test row is owned by `unrelated-owner` and has manager scope, so neither clause matches. Production would reject this request with 404 before RPC. A real admin preview first substitutes the effective target's ID and email, then uses the ordinary scoped predicate. Admin status alone is not unrestricted manager-mailbox authority.

Impact: the new test passes even when effective-viewer resolution is absent or incorrect. It cannot establish the correction plan's required effective-admin permission evidence and encodes an unsafe permission contract for future changes. This is a test correctness and acceptance defect, not a demonstrated production authorization bypass.

Mandatory correction 2: use the real scope helper with a filter-aware database model and exercise authenticated-admin-to-effective-target resolution. Assert that target-owned manager sources succeed, unrelated manager sources fail, and a mixed batch writes nothing. Keep the existing co-manager `inbox/edit` call assertion. The co-manager test now meaningfully exercises owner filtering and read-versus-edit composition, but still supplies linked-owner results directly rather than proving grant normalization; real helper-backed empty/read/edit fixtures would complete that boundary.

## Original finding resolution and passing controls

1. **Original partial-success P2: fixed on the server.** `route.ts:156-189` encloses each source operation, including its retry read, in its own catch. A successful A followed by failed B returns HTTP 500 with A=`read,false` and B=`failed,<initial unread>`, retaining confirmed outcomes and continuing the bounded batch. An earlier `alreadyRead` also remains false. No generic-write fallback was added. The new test at `portal-inbox-read-route-contract.test.ts:196-221` explicitly models A commit followed by B error. The transport parser at `portal-inbox-storage.ts:953-981` accepts validated per-source results even on HTTP 500, so the earlier results are no longer discarded solely due to HTTP status. Full UI rollback/unknown-network reconciliation belongs to the primary review.
2. **All-batch authorization is preserved.** `route.ts:134-155` resolves authenticated/effective authority, limits the action to manager mailbox scope, validates unique bounded IDs/observations, requests linked-owner authority at `inbox/edit`, applies the existing scope filter, and requires all requested records and matching stored scopes before the first RPC. Inaccessible/missing/mixed-scope batches return no member state and perform no source writes. The initial query's explicit scope check remains after retrieval, before any response metadata or mutation.
3. **Empty permissions do not grant owner access.** The unchanged `viewerAndLinkedOwnerIdsForModule` delegates to accepted, assigned-property grants in `linkedOwnerScopeForModule`; `normalizePropertyCoManagerPermissions` and `coManagerModuleAllowed` do not treat `{}` as full access. The existing participant-email authorization branch is preserved, so this review does not claim that mailbox scope itself is a manager-role check or re-audit historical mailbox permissions.
4. **Observations remain stale-state checks, not credentials.** `portal-inbox-read-state.server.ts:13-26` hashes durable identity, timestamp and complete canonical JSON with stable object ordering and preserved array order. `route.ts:88-91` overwrites browser/stored read metadata with the actual returned record ID, freshly computed observation, source unread boolean and complete marker. No source absent from GET gains authority from historical navigation IDs. The POST does not accept a requested new unread value or browser-owned JSON/identity for SQL.
5. **Exact CAS and bounded scoped rereads remain intact.** `route.ts:164-182` compares the original browser observation, sends identity/JSON/timestamp from the authorized DB row, and retries at most twice. After a false result, the reread reapplies row ID, manager scope and the shared authorization filter. Revised content cannot upgrade the original observation. SQL checks owner, participant, thread type, scope, timestamp and exact JSONB; same-timestamp body/draft/folder changes defeat CAS. Only unread and a strictly advanced timestamp change. Trash, invalid folders and non-boolean unread do not update.
6. **RPC exposure remains restricted.** Migration lines 7-24 retain `SECURITY INVOKER`, an empty search path, fully qualified relations/functions, and transactional execution revokes for PUBLIC/anon/authenticated with a service_role grant. The migration hash is unchanged from the independently validated DEV apply. No reapply or probe was needed or performed.
7. **Both transport fields are stripped at durable boundaries.** `route.ts:24-30,252-254` drops `readSources` and `readSourcesComplete` before building upsert JSON. `portal-inbox-storage.ts:414-428,521-529` strips both in normal upsert/replace and the legacy replace writer. Viewer cache retention does not turn metadata into authorization.

## Remaining limits

- The route test fake still ignores `.in` and `.eq` arguments and has no CAS-miss/reread error scenario. It does not behaviorally prove ID/scope retry filtering, same-timestamp revision between lookup and RPC, second-attempt bound, or earlier outcome retention after a retry-read error. Source inspection supports those controls; the independently executed SQL probes establish SQL behavior, not full route composition.
- Co-manager grants are resolved for the batch and reused on a CAS reread. A simultaneous grant revocation is not serialized with every RPC. This inherited, explicitly accepted cross-table race remains; row identity changes still defeat CAS.
- This review does not repeat full unit/lint/build or DEV database validation, and does not independently validate the UI/server partial-response combination under unknown network outcomes.

## Frozen-source fingerprints

```text
c2dc31c57d03082cbc0b45719cb730d7de3bde049066f1e6bd5255e6d48d6ff7  src/app/api/portal-inbox-threads/route.ts
5d628c0829160cd6fcd50e957dfd8369267f66b17b1e9f764d14e1f85b7f5c11  src/lib/portal-inbox-read-state.server.ts
21b69ff56b8795ed9751da7969e563d437012d2ea19c84f07d983804bda51192  src/lib/portal-inbox-storage.ts
8a6007c229d637f3eb4d6091650ddb8c546a7f5dee353abcb157e4bd99f5bad6  supabase/migrations/20260913170000_mark_portal_inbox_source_read.sql
28931f97fd4b7c012391520c582684e789f2923e7750df99e6b302c6d428f99b  tests/unit/portal-inbox-read-route-contract.test.ts
```
