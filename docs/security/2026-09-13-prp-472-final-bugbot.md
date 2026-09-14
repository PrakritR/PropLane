# PRP-472 final Bugbot review - September 13, 2026

Result: **changes required**. Two Medium / P2 correctness findings remain. No Critical or High finding was identified within this client review boundary. This is not final acceptance of C1-C4 or release approval.

## Reviewed source and method

- Worktree: `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/6/AXIS-2`.
- Integration base/HEAD supplied by root: `3c997bc4f09ef3b97c80cb559e8909830e164868`, plus the frozen uncommitted PRP-472 source/test changes.
- Source manifest: `/private/tmp/axis-inbox-cycle/prp472-c2-source-freeze.json`; aggregate `45f0449be351e47abb675cb3e9b38283a015c4f94259290ad0cb00758ba8347c`. Independently hashed all 18 listed files: zero mismatches.
- Read root/Akhil instructions, ship gate, Communication documentation, correction-2 plan/handoff, root/RPC validation, and both prior Bugbot reports. Reviewed controller, reconciliation, source collapse, selected email/native resolution, pane attempt lifecycle, SMS storage utility/panel, and retained regression tests. Server authorization and deployment gates belong to the other final reviewers/root.
- No application/source/test edits, git operations, graph operations, broad test runner, browser/server operation, database action, provider send, no-mistakes, staging or production operation. This report is the only repository write. Parent explicitly requested a private replay harness after the read-only stdin reproductions.

## F-B1 - Medium / P2: an older failed operation overwrites newer confirmed source truth

Locations: `src/lib/portal-inbox-storage.ts:1056` through `:1059`; rollback at `src/lib/portal-inbox-read-operation.client.ts:91` and `:103`. Reachable alias selection and exact-source wiring: `src/components/portal/pro-unified-inbox.tsx:564`, `:990`, `:1038`.

The new optimistic token protects deletion of another operation's overlay, but settled reconciliation always writes `source.unread`. A network-unknown old operation therefore publishes its captured rollback baseline as confirmed truth even when a newer operation has already confirmed that same observation read.

Concrete sequence using two email aliases sharing explicit native binding K1:

1. Current source A/email1 has observation A1 and unread true; B/email2 has B1 and unread true. Open the merged conversation and hold operation `[A1,B1]`.
2. A fresh GET retains A1 but supplies revised B2. The pane's changed source signature starts `[A1,B2]` while the first request is pending.
3. The newer request succeeds for both sources. Both rows and their confirmed `readSources[].unread` become false.
4. The older request rejects. Its saved A unread=true passes the current exact-observation guard. Completeness is evaluated separately for each email, so B's mismatch does not prevent A's patch. A's row and confirmed source truth return to unread=true, while B stays read.

Actual-function probe result:

```json
{"phase":"newer-success","A":{"rowUnread":false,"sourceUnread":false},"B":{"rowUnread":false,"sourceUnread":false}}
{"phase":"older-failure","A":{"rowUnread":true,"sourceUnread":true},"B":{"rowUnread":false,"sourceUnread":false},"pending":0,"calls":2}
```

The probe runs the exact current controller and reconciliation function, with a controlled GET replacement and network promises. Bodies remain unchanged. This is a false unread badge and lost confirmed truth, not a durable write or message-content loss. The ordinary successful-open then failed-reopen path is fixed; overlapping observations within one viewer epoch remain incorrect.

Required correction: unknown/failure settlement must withdraw only the operation's compatible optimistic contribution and retain current confirmed truth. It must not install an obsolete captured baseline over a later confirmation. Keep exact-observation/new-GET guards and known partial outcomes. Retain a controller-plus-real-reconciliation test with `[A,B-old]`/`[A,B-new]`, different aliases sharing one explicit binding, both settlement orders, and source/aggregate assertions.

Coverage limitation: the controller tests named for confirmed baselines and partial success supply the next baseline manually and mock `applyUnread`. The test named `cleans only its own pending token when duplicate operations settle out of order` actually suppresses the duplicate while the first is pending, then starts its second request after settlement; it does not exercise overlapping source sets. The nine-case actual manager wiring suite includes ordinary failed reopen but no overlapping source revision sequence. The handoff's overlapping/out-of-order coverage claim is broader than these retained tests.

## F-B2 - Medium / P2: a retained SMS panel skips the persistence retry it tells the user to make

Location: `src/components/portal/pro-sms-panel.tsx:427`, with the new volatile receipt at `:435` and recovery toast at `:438`. Calls: `openThread` at `:442` and controlled selection effect at `:454`.

When `markManagerSmsOpenedIds` throws, the catch now adds every inbound ID to the in-memory set and tells the user to reopen. On a later open in the same mounted panel, the early return sees those volatile IDs and never calls the storage helper, even after storage has recovered. The helper itself correctly distinguishes volatile membership from durable membership; this caller prevents it from doing so.

The affected retained component is reachable through SMS-only A -> B -> A selection in `ManagerUnifiedInbox` (`pro-unified-inbox.tsx:1157`) and the inline SMS list in admin Communication (`admin-communication.tsx:125`, when SMS UI is enabled). A full unified Back that unmounts the SMS panel can reset memory and recover; this finding does not claim that every navigation path fails. The combined `ResidentDirectChatPane` controller also uses a different callback and is not affected by this early return.

Actual callback + actual storage utility probe:

```json
{"case":"persist-fails-storage-recovers-retained-panel-reopens","writes":1,"toasts":1,"stored":"[]","memory":["sms1"]}
```

The first write fails, storage is restored, and the second explicit open performs zero additional writes. The UI continues treating the ID as opened in memory, but it returns unread after a later reload. This is a recoverability regression introduced by combining the new volatile union with the existing early return.

Required correction: separate whether this visible attempt was consumed from whether its receipts were persisted. A fresh explicit open must retry undurable IDs without creating a render-driven loop. Add a retained real `ManagerSmsPanel` test for failed storage -> recovered storage -> A/B/A or list reopen. The new manager integration suite mocks `ManagerSmsPanel` to null, so its passing combined-pane storage test cannot cover this regression.

## Verified improvements and limits

- C1 now updates per-source confirmed truth even when the aggregate remains unread; ordinary success then failed reopen is covered by the real manager/controller/reconciliation integration. This fixes the original stale-GET baseline example but does not close F-B1.
- C2's combined pane distinguishes hidden/stale deferral from a visible attempted failure, latches the latter, publishes sets only on membership changes, and permits native arrivals while one exact email signature is pending. Viewer authority/epoch checks guard retained callbacks, results, and failure notifications; pending cleanup is symbol-owned. Actual manager tests cover held-request storage failure, explicit recovery, native arrival on success/failure, hidden document and mobile pane, and a stale viewer settlement.
- C3 preserves explicit K1/K2 provenance through person/assistant/unified collapse and selected-native resolution gives declared bindings priority over historical native member keys. The retained actual manager test verifies raw A/K1+B/K2 renders both exact native bodies and excludes K3 from display and opened IDs. The report does not claim that one test covers all unresolved/legacy/successive-collapse permutations required by the plan.
- R1's complete-current-source guard and R5's actual person/assistant observation unions remain in place. Reconciliation spreads current rows, preserving content rather than restoring old message snapshots. Source metadata is stripped at both client whole-row writer boundaries. No new content-loss or exact-native-member finding was identified in the inspected paths.
- Root's final full unit result (1,461 files / 10,320 tests), lint (0 errors / 746 warnings), build exit 0, browser evidence, and independent DEV RPC validation are attributed to their dated reports, not rerun here. Passing broad checks do not establish the missing race or retained-panel cases above. No independent browser or database reproduction is claimed.

## Replay evidence

Parent-authorized private harness: `/private/tmp/axis-inbox-cycle/prp472-c2-final-review-probes.cjs`.

```text
/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin/node /private/tmp/axis-inbox-cycle/prp472-c2-final-review-probes.cjs
```

Exit **0**. It reads frozen source, uses installed TypeScript to extract/transpile the actual functions and callback, and executes both controlled reproductions. It imports no application module and performs no network or application-state mutation. It asserts the observed defects, so exit 0 means reproduction succeeded, not that the feature passed. Parent independently reproduced F-B1 as well.

Both findings were sent to the parent immediately. Under the correction-2 plan, remaining findings must be reported to Akhil; this review does not initiate another automated correction or waive acceptance.
