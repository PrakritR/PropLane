# PRP-472 correction 1 Bugbot review - 2026-09-13

Result: **changes required**. R1 aggregate protection and R5 observation/attachment propagation are corrected in the assigned storage boundary. Two Medium / P2 findings still block approval of the complete correction contract.

## Reviewed boundary

- Worktree: `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/6/AXIS-2`.
- Integration HEAD: `3c997bc4f09ef3b97c80cb559e8909830e164868`, plus the frozen uncommitted correction-1 source.
- Primary scope: `src/lib/portal-inbox-storage.ts`, `src/lib/unified-inbox-merge.ts`, `src/lib/manager-sms-opened.client.ts`, and `tests/unit/portal-inbox-read-storage-contract.test.ts`.
- Read the actual read-operation helper, selected-source/native resolver, pane receipt signature, and related tests only to establish storage/merge reachability. Parent owns React/controller, server/security, and broader integration findings.
- Read root/Akhil instructions, communication documentation, correction plan/handoff, original fresh review, and original Bugbot report. Neither `.graphify/graph.json` nor the legacy graph was available; existence check exited 1. No graph build/install was attempted.
- No source edits, git mutations, no-mistakes, browser/server actions, database operations, provider sends, or broad test runners. Only this report was written. Parent/root authorized the two small Node probes described below; they execute extracted frozen functions without loading the application or networking. Root retains full unit/lint/build ownership.

Source SHA-256:

| File | SHA-256 |
| --- | --- |
| portal-inbox-storage.ts | `21b69ff56b8795ed9751da7969e563d437012d2ea19c84f07d983804bda51192` |
| unified-inbox-merge.ts | `06b400a799cdec4995dbb897446c7c95d13cf3e14f99c38ec3becbf61741f26b` |
| manager-sms-opened.client.ts | `c09b43739297196046e5495dbcdaf62194608ea602ede3032348c7fe8800beee` |
| portal-inbox-read-operation.client.ts | `c490a0e773fd6e522966a16da0d26a05ab6686754ec59bbc828dd19b498d80bb` |
| portal-inbox-read-storage-contract.test.ts | `a57961808ca0839e9e0bb63f2e09b00f5df3c9a330a7a6dbd5cc7f597e50b20f` |

## C1-B1 - Medium / P2: a failed repeated read restores stale source unread metadata

Locations: `src/lib/portal-inbox-storage.ts:1017`, `src/lib/portal-inbox-read-operation.client.ts:60`, `src/components/portal/pro-unified-inbox.tsx:967`.

Reconciliation updates `thread.unread` only. A successful acknowledgement therefore leaves `thread.readSources[].unread` at its original GET value. The selected list row forwards that unchanged source state to the next operation, whose rollback snapshot is built from `source.unread`, not the current acknowledged truth. Reopen a successfully read conversation before a fresh GET, or receive another native SMS that creates a new pane signature, then fail its email POST: rollback changes the previously read email row back to unread. Pending ownership is correctly released, but the badge is false information. Partial successful results likewise never update per-source acknowledged state.

Actual-function probe, Node `v22.23.0`, exit 0. It extracts `reconcileObservedInboxReadRows` and `startObservedInboxReadOperation` with TypeScript AST, transpiles them, and runs their real success/failure chain with controlled promises and the current cached row:

```json
{"case":"success","rowUnread":false,"sourceUnread":true,"pending":0}
{"case":"failed-reopen-after-success","rowUnread":true,"sourceUnread":true,"notices":1,"pending":0}
{"case":"partial-success","rowUnread":true,"sources":[{"id":"A","unread":true,"observation":"obs-A"},{"id":"B","unread":true,"observation":"obs-B"}]}
{"case":"partial-reopen-success","rowUnread":false,"sources":[{"id":"A","unread":true,"observation":"obs-A"},{"id":"B","unread":true,"observation":"obs-B"}]}
{"case":"failed-reopen-after-partial-then-success","rowUnread":true,"sources":[{"id":"A","unread":true,"observation":"obs-A"},{"id":"B","unread":true,"observation":"obs-B"}],"pending":0}
```

Required correction: keep confirmed source unread state and aggregate state coherent across operations, while preserving operation-owned rollback and stale-observation guards. Do not simply overwrite the rollback baseline with an optimistic value. Add success -> reopen -> failure and partial success -> retry success -> later failure tests through real storage and the actual controller. Existing tests instantiate fresh source metadata or mock `applyUnread`, so they miss this state chain.

## C1-B2 - Medium / P2: person collapse erases conflicting explicit SMS bindings and permits unrelated email fallback

Locations: `src/lib/portal-inbox-storage.ts:929` and `:946`; downstream mapping at `src/components/portal/pro-unified-inbox.tsx:546`, `:548`, `:579`, `:622`; selection at `:984` through `:1000`.

Two authorized email rows for one email address with distinct explicit native keys K1 and K2 collapse to one row with `smsConversationKey: undefined`. This loses the information that explicit membership existed. If K1/K2 are absent from the native payload and another authorized native conversation K3 has that email (for example another role), the selected email row can resolve K3 through unique email fallback. On the active list, it can also merge K3 directly under the email person key and then treat K3 as explicit selected membership. The new read callback opens K3's inbound IDs. This violates the correction contract that unresolved explicit keys never fall back and unrelated role/owner sources stay excluded.

The binding-dropping collapse expression predates this correction. This is an existing preservation gap extended into the new observed-read path, not a claim that this cycle introduced the original collapse behavior. It does not establish an authorization bypass or disclosure beyond the manager's already authorized GET payload.

Actual-function probe, Node `v22.23.0`, exit 0. It extracts the real person-collapse and unified-merge functions and the actual `selectedSmsResidents` useMemo callback from the frozen source. Fixture native IDs use `conversationKey`, so the identity adapter returns that exact field. No phone matching is involved:

```json
{"case":"conflicting-explicit-bindings","originalKeys":["K1","K2"],"collapsedKey":null,"emailOnlySelectedNative":["K3"]}
{"case":"conflicting-bindings-active-list","memberKeys":["sms:K3","email:A","email:B"],"selectedNative":["K3"]}
```

Required correction: retain explicit native membership or an explicit unresolved/conflict marker across person collapse, list identity, and selected snapshot construction. Missing/conflicting explicit keys must never silently become permission to fall back by email. Add an actual controller test for two explicit keys with neither resolved plus a third same-email native row, and a positive test for all resolved explicit members. Keep historical email `sourceThreadIds` separate from native/read authority.

## Verified corrections and invariants

- **R1:** `reconcileObservedInboxReadRows` now requires every current source in the affected non-trash email group to have complete metadata, the exact requested observation, and an explicit result map entry. New B, revised B, missing B result, legacy B, or a conflict-cleared member prevent the old operation from changing A's aggregate. The first actual-function probe checked merged new/revised/missing cases, mixed legacy rows, a conflict marker, and trash. Every result retained the exact current row object, including its body, preview, time, draft, root attachments, and appended attachments. These cases printed `preservesWholeRowAndContentReferences:true` and exited 0. The successful path spreads the current row and changes only unread; it cannot restore an old body or attachment reference.
- **R5:** Person and genuine multirow assistant branches both call `mergeInboxReadSourceState`; incomplete/legacy members produce empty observations plus `readSourcesComplete:false`, and conflicting observations or explicit unread disagreement fail closed. The false marker survives successive passes. Unified merge applies equivalent checks to email contributors while treating native SMS as its separate receipt domain.
- The second actual-function probe passed two `agent_notice_<same-owner>_*` rows with distinct emails through the actual assistant merging branch. Result: two observations, complete marker true, oldest root body retained with no root attachment, appended `/append.pdf` attached to its own message, and later `/new-root.pdf` attached to the later root message. A conflicting observation followed by a third assistant row remained `readSources:[]`, `readSourcesComplete:false`. This exercises a real multirow assistant branch rather than a singleton passed through twice.
- **Durable client serialization:** both response-only fields (`readSources` and `readSourcesComplete`) are stripped by the shared upsert/replace serializer at storage line 415 and legacy `persistInbox` replace writer at line 522. Delete/folder writers send IDs and action metadata only. Memory/session caching intentionally keeps observation metadata. The new test asserts `readSources` removal only; adding an assertion for `readSourcesComplete` and both writer entry points would improve durability regression coverage, but inspected code strips both now. Server durable normalization also visibly strips both at route line 25; deeper server authorization review belongs to the security reviewer.
- Local SMS receipt storage is viewer-keyed, reloads before unioning IDs, ignores legacy unscoped receipt sets, and throws on failed persistence so its caller can detect failure. It adds no network fetch. Parent owns whether React failure handling remains bounded; no claim of a passing actual UI failure loop is made here.
- The selected native resolver itself correctly refuses email fallback when at least one explicit selected key survives. It returns every matching explicit native row and requires a unique email match only in the no-explicit-key branch. C1-B2 concerns losing that prerequisite information upstream.

## Validation limits and handoff

Both probes ran as heredoc stdin to `/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin/node`, using installed TypeScript only for extraction/transpilation. They are deterministic function tests, not browser or complete React tests. No temporary probe file or application source was written. Their input/output and relevant source locations are retained above so the findings do not depend on a private script.

The correction handoff's 37 regression tests, compatibility/integration suites, typecheck/lint, and browser evidence are attributed implementation evidence, not checks rerun here. Root's frozen full unit/lint/build gate remains independent. No schema change or database replay is needed to address these client findings. Parent was notified immediately of both findings and owns the combined review disposition.
