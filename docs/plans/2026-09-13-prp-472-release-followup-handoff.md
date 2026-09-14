# PRP-472 release follow-up handoff

## Scope and integrated candidate

Akhil authorized this bounded F1/F2 correction and the release ladder in the
release follow-up plan. Root owns Git publication, broad validation, staging,
production, and Linear. This follow-up made no provider sends and no staging or
production writes.

The PRP-472 checkpoint is `d0a61f43aace736dcfaa5def1f5f90520a3df13a`.
Root then merged pinned main `75d711053085e340072c605bcb96eaa9416ef87e`
without conflicts. The integrated browser and focused test candidate was
`276e1e40a0a9f3f63bee3a87b4fabbbd9edaf54b`, followed by the narrow uncommitted
failed-envelope correction described below.

## Corrections

F1 now distinguishes a confirmed server settlement from withdrawal of an
unknown operation. A rejected, malformed, or missing old outcome removes only
that operation's compatible token-owned overlay. It does not restore a stale
captured unread value over newer confirmed source truth. Confirmed partial
source outcomes remain source-specific.

A fresh security probe then found that a syntactically valid `status: "failed"`
envelope was still being treated as confirmed. The route derives its unread bit
from the record captured before the failed RPC, so an older failed envelope
could overwrite a newer success. `failed` is now an unknown per-source outcome:
it withdraws only its owned overlay, while valid successful siblings in the
same response still settle independently. The real controller and reconciler
regression covers both settlement orders for A1/B1 to A1/B2 and preserves the
partial good result.

F2 now lets each explicit mounted SMS open reach the durable opened-receipt
helper. Volatile in-memory membership no longer prevents recovery after a
failed localStorage write. The mounted test exposed one additional acceptance
failure: a controlled pane mounted while the document was hidden could persist
its receipt. The panel now defers that controlled selection and retries it once
on `visibilitychange` after the document becomes visible. Repeated visibility
events do not write again.

The follow-up implementation and retained regressions are in:

- `src/lib/portal-inbox-read-operation.client.ts`
- `src/lib/portal-inbox-storage.ts`
- `src/components/portal/pro-sms-panel.tsx`
- `tests/unit/portal-inbox-read-operation.test.ts`
- `tests/unit/pro-sms-panel-opened-retry.test.tsx`

No SQL change was required for F1/F2.

## Focused validation

All commands used Node `v22.23.0`. The final focused run after the visibility
correction was:

```text
/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin/node node_modules/vitest/vitest.mjs run tests/unit/portal-inbox-read-operation.test.ts tests/unit/portal-inbox-read-storage-contract.test.ts tests/unit/pro-sms-panel-opened-retry.test.tsx tests/unit/manager-sms-panel-opened-loop.test.tsx tests/unit/manager-unified-inbox-read-integration.test.tsx tests/unit/unified-conversation-inbox.test.tsx tests/unit/portal-inbox-read-observation.test.ts tests/unit/manager-resident-detail-inbox.test.tsx tests/unit/portal-inbox-read-route-contract.test.ts
```

Exit 0: 8 files and 74 tests passed. `git diff --check` also exited 0 in the
same command. Earlier integrated focused groups passed before the final
visibility refinement:

- 6 files, 52 tests for controller, storage, mounted SMS, combined pane, and
  unified inbox behavior: exit 0.
- 9 files, 69 tests for read observation/controller/storage, mounted SMS,
  manager integration, resident detail, route contract, effective viewer, and
  co-manager grants: exit 0.
- 17 PRP-470 compatibility files, 121 tests covering readiness, polling,
  coalescing, cold-cache/merge, stages, status, archive, actions, notices,
  resident, and unified communication behavior: exit 0.
- TypeScript with the Node22 6 GB heap: exit 0.
- ESLint over the five F1/F2 source and test files: exit 0 with existing
  warnings only.
- After the final visibility listener, the existing SMS opened-loop tests
  passed 2 of 2, TypeScript exited 0, and focused ESLint exited 0.

The required graph refresh was attempted once with
`npx graphify hook-rebuild`. It exited 1 with `npm error could not determine
executable to run`; no global graph repair was attempted.

## Integrated DEV browser evidence

The server ran on pinned port 3009 with:

```text
SMS_COMM_UI_ENABLED=true
SMS_RUNTIME_ENABLED=0
SMS_OUTBOX_SCHEDULER_READY=0
SMS_PROVISIONING_ENABLED=0
```

The browser used the authenticated manager account and the real manager route
for the merged conversation. Mobile rendering at 390 by 844 showed the exact
synthetic email and SMS messages.

The exact synthetic DEV fixture had disappeared, so the separately authorized
insert-only reconstruction first verified manager auth ID
`c02c7ffd-50ec-47d0-acf2-82928be6db27` and resident auth ID
`f4290f7c-31c7-469e-b0bb-859f5ce37f46`, including their canonical emails.
It inserted only the absent inbox row `prp472-dev-merged-read`; native row
`23cd9472-4720-4472-8472-000000000001` already existed and was not overwritten.
Readback found exactly one of each row, correct ownership/emails, the exact
native binding, root body `PRP-472 email probe1`, one appended message
`PRP-472 email probe2`, and no persisted response metadata. Existing unrelated
inbox and SMS rows were preserved.

F1 browser results:

- After a confirmed success, reopening under forced mark-read HTTP 500 with
  zero intervening thread GETs left both email bodies and SMS content present,
  left zero unread markers, and produced one bounded error toast. The unknown
  old outcome did not resurrect confirmed unread.
- After a bounded reset of only `prp472-dev-merged-read` to unread, a forced
  first open failure retained the unread marker and produced one toast. An
  explicit reopen posted a real success with no intervening GET. Authenticated
  API readback then showed aggregate unread false and source unread false.

F2 used the actual mounted `ManagerSmsPanel`. A browser-only GET response filter
omitted the canonical email row so the real SMS-only branch was reachable; it
did not modify database data. The exact opened-receipt key began with an
unrelated sentinel. Forced localStorage failure produced one bounded write
attempt and one toast, with no render loop. After storage recovery, explicit
reopen produced the second attempt, stored both the unrelated sentinel and the
native SMS ID, and a reload retained both with zero unread indicators. The test
then restored the exact opened-receipt key to the native ID only and removed
its browser control key. The retained mounted React regression additionally
drives the complete A/B/A two-failure sequence and proves hidden-to-visible
deferral writes exactly once.

No compose action, provider request, fixture delete, fixture overwrite, or
non-DEV database write occurred. Port 3009 was stopped and the browser session
was closed before this handoff.

## Source freeze and remaining gates

The final PRP-472 source consists of integrated HEAD
`276e1e40a0a9f3f63bee3a87b4fabbbd9edaf54b` plus the reviewed uncommitted
failed-envelope change in the controller and its retained test. At freeze time,
the other modified/untracked paths belonged to the plan, this handoff, and
root's separate tour-recovery release work. The five
F1/F2 files above have combined SHA-256
`f46aa05062720f6d03731ee8b0a371d7637c366eb070692e0dd6818064591f91`.

Individual SHA-256 values:

```text
60c1c55b16b53cd8ab4727cef843b55a970c7732d4da5bfabc091d7d660647b3  src/lib/portal-inbox-read-operation.client.ts
717bbb015ff3a9746f1a308c4e1547641995839123735f3d8ec781a3bcfc1bc9  src/lib/portal-inbox-storage.ts
f1c516cf1f00e73b5ea7490f98cba711844b9b0978540637647888e44ab3968d  src/components/portal/pro-sms-panel.tsx
c5ed6cfade5fa5b5713977a1bb7928f4701d31fe5ac5d7c0eaa2c7c0ae0eb194  tests/unit/portal-inbox-read-operation.test.ts
6c28b89781bfdddd4282f56645e05f66e92dfaf64113aedd0e10b01fe160def5  tests/unit/pro-sms-panel-opened-retry.test.tsx
```

Root still owns the serial full unit, lint, build, required local portal E2E,
fresh Astra/security/Bugbot review, exact migration review, staging QA, and the
authorized release ladder. This handoff does not claim staging or production
validation.
