# PRP-470 correction cycle 2 execution handoff

Date: 2026-09-13. This is the second and final automated correction execution. Return this keeper to root for fresh Astra review and affected security/Bugbot re-review. No release or promotion is authorized by this handoff.

## Identity and scope

- Worktree: `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/6/AXIS-2`.
- Branch: `akhil/prp-470-inbox-loading`.
- Starting and current HEAD: `7b3d464fe2f102a527949044fc0289513d50029f`, plus the complete uncommitted PRP-470 implementation and review artifacts.
- Plan: `docs/plans/2026-09-13-prp-470-correction-2.md`.
- Correction scope: the manager direct-send email refresh race reported in correction-1 review. Existing account-authentication, contact isolation, initial readiness, and SMS fixes were preserved.
- Correction-cycle source/test files changed: `src/components/portal/pro-unified-inbox.tsx` and `tests/unit/inbox-initial-loading-readiness.test.tsx`.
- No schema, RLS, route, provider-send, attachment, native registry, production, staging, commit, push, PR, or Linear change occurred. No no-mistakes pipeline was invoked.

Final candidate identity:

- Combined full `src`/`tests` tracked diff plus the two untracked source/test file hashes: `97b5ee3c3cb59674dfd51f1da5f19f9712f62ae39156dddea1dcc9159fe53fb1`.
- `src/components/portal/communication-inbox-initial-state.tsx`: `eea7d384a39695e42e9ffd8648ae231e8290fa4808d42c94ca88012bb22c6a03`.
- `tests/unit/inbox-initial-loading-readiness.test.tsx`: `1094d08a91e66631803cb30d8b91813bee484f80ea8c5b3886cf01b969b318ee`.

## Correction implemented

`refreshAfterDirectSend` now uses `syncPersistedInboxFromServerWithStatus` and keeps its `ok` and `stale` result. The callback captures a viewer authority object created for the current rendered viewer. Object identity changes on every viewer transition, including A to B to A, so a retained callback cannot borrow the latest epoch merely because the viewer string matches again.

The callback checks that rendered authority and viewer id before starting either forced email refresh or guarded SMS refresh. It also uses a monotonic direct-send request generation and repeats the authority/generation checks before publishing email rows, selecting the resulting thread, calling the parent route callback, or changing the browser URL. Failed, rejected, or stale results leave the current usable rows and selection unchanged.

Forced post-send reads run through a viewer-authority-scoped `createCoalescedRefresher`. A first post-write call starts immediately. Further forced callers while it is pending share one trailing read that begins after the first settles, preserving the helper's freshness promise while bounding three concurrent callbacks to two non-overlapping reads. The map is cleared on viewer transition. Legacy array-only storage exports remain unchanged for other consumers.

The test harness mounts the real `ManagerUnifiedInbox` callback behind a mocked authorized direct pane, so it never calls a provider. Six permanent regressions cover:

1. A refresh pending, B initial load ready, then A stale completion. B's row, selection, and route remain.
2. A to B to A completion isolation when viewer strings repeat.
3. Same-viewer failed refresh preserving usable rows and selection.
4. Same-viewer success replacing a directory-only placeholder with the sent thread and route.
5. Three repeated callbacks producing one active read and one shared trailing read, never three overlapping reads.
6. A rendered callback retained until after B takes over performing zero forced reads and no route publication.

The mock preserves the production status-loader signature `(storageKey, options)`. An intermediate harness version treated the first argument as options and therefore mislabeled forced calls as unforced; that harness defect was corrected before the final 26-case and 76-case green runs.

## Publication inventory

| Surface | Final disposition |
| --- | --- |
| Manager initial email/applications | `loadInitialList` remains guarded by `initialLoadGeneration`; stale storage/application results return without publication, and only successful current results update rows/directory readiness. |
| Manager cache/event/assistant | Cache and store-event reads are synchronous against viewer-scoped storage. Assistant staging is a synchronous current-effect publication queued as a microtask, and provisional rows remain hidden until `initialListReady`. No changed asynchronous read API reaches this path. |
| Manager SMS | `loadSms` still captures viewer id/epoch and checks them before authorization latch effects and normalized row publication. Polling, visibility refresh, contact events, and direct-send SMS all use that guarded loader. The direct-send entry guard now also prevents a retained old callback from starting the SMS read. |
| Manager direct-send email | Corrected to status-aware, viewer-authority and latest-request guarded publication with a scoped forced-read coalescer. Rows, selection, parent route, and URL share the same acceptance boundary. |
| Resident initial email/SMS | `loadInitialList` and `loadResidentSms` remain generation/epoch guarded. Status failure does not publish stale email rows, and initial membership stays hidden until enabled sources succeed. No correction-2 source change was needed. |
| Resident cache/event/assistant | Synchronous reads use the current viewer cache, and provisional cache/assistant data remains behind readiness. No correction-2 source change was needed. |
| Manager/resident bulk callbacks | Archive, restore, and delete are separate writes. They call `onEmailThreadsChange` only after their mutation reports success. They do not consume the changed status read API, so their existing write behavior was left unchanged rather than certified as a new viewer-generation design. |
| Child selection/route callbacks | Row-open and controlled-id callbacks are synchronous. `ResidentDirectChatPane.onSent` is the corrected manager callback. Its asynchronous publications now share one authority boundary. |

## Validation

The explicit validation runtime was `/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin/node`, verified as `v22.23.0` with exit 0.

- `/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin/node node_modules/vitest/vitest.mjs run tests/unit/inbox-initial-loading-readiness.test.tsx --no-file-parallelism`
  - exit 0; 1 file, 26 tests.
- `/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin/node node_modules/vitest/vitest.mjs run tests/unit/inbox-initial-loading-readiness.test.tsx tests/unit/unified-conversation-inbox.test.tsx tests/unit/resident-conversation-inbox.test.tsx tests/unit/unified-inbox-sms-poll.test.tsx tests/unit/inbox-empty-states.test.tsx tests/unit/portal-inbox-account-switch-leak.test.ts tests/unit/portal-inbox-trash-race.test.ts tests/unit/portal-inbox-merge.test.ts tests/unit/communication-resident-placeholders.test.ts tests/unit/coalesced-refresh.test.ts tests/unit/portal-sync-dedup.test.ts tests/unit/manager-inbox-contacts.test.ts --no-file-parallelism`
  - exit 0; 12 files, 76 tests.
- `/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin/node node_modules/eslint/bin/eslint.js src/components/portal/pro-unified-inbox.tsx tests/unit/inbox-initial-loading-readiness.test.tsx --quiet`
  - exit 0.
- `NODE_OPTIONS=--max-old-space-size=8192 /Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin/node node_modules/typescript/bin/tsc --noEmit --pretty false`
  - exit 0.
- `git diff --check`
  - exit 0.
- `PATH=/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin:/usr/bin:/bin npm run ship:preflight`
  - exit 0; 11 checks passed with the expected dirty-tree, unavailable production env/parity, and missing local Langfuse warnings. No promotion followed.
- `PATH=/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin:/usr/bin:/bin npx graphify hook-rebuild`
  - exit 1 with `npm error could not determine executable to run`. Neither `.graphify/graph.json` nor `graphify-out/graph.json` exists in this pool checkout. The known npm-executable limitation was recorded without changing global tooling or another worktree.

Root owns the final full-unit and build runs to avoid duplicate broad runners. At handoff time, full unit was running under explicit Node 22 in root session `89976`, with log `/private/tmp/axis-inbox-cycle/prp470-c2-full-unit.log`; build had not started. Fresh Astra must wait for and record those root-owned exits before a final keeper verdict.

## Browser evidence and Review URL

Root's existing dev/test server was reused on pinned port 3009. The supplied runtime is Node 22.23.0 with `SMS_COMM_UI_ENABLED=1`, SMS runtime disabled, scheduler disabled, and exact dev/test Supabase project `emstjswhotsnyksqhqyf`. It is root-owned session `87752`; this executor did not stop or restart it.

Playwright CLI reused authenticated session `inbox-cycle` with `/private/tmp/axis-inbox-cycle/playwright.json`. The base manager route showed the complete existing fixture list, including `Morgan No Message`. Selecting that directory-only fixture changed the URL to `/portal/communication/active/c02c7ffd-50ec-47d0-acf2-82928be6db27%3Aapplicant%3A`, displayed Morgan and the exact test email, and rendered one empty reply textbox with disabled Send. No text was entered, no saved draft was changed, and no provider message was sent. The correction callback itself is exercised through the six provider-free behavioral regressions above. The prior mobile loading and 503 Retry browser evidence is unchanged and remains recorded in correction-1 review/handoff.

`npm run sandbox:pin -- 3009` exited 0 and confirmed an existing server. `npm run sandbox:open -- /portal/communication/active` exited 0 and produced:

`http://localhost:3009/portal/communication/active`

A direct unauthenticated reachability probe returned HTTP 307 to sign-in, confirming the server answers.

## Remaining limits and fresh-review prompt

Full portal E2E and staging QA remain release gates. Browser QA does not simulate an account switch after an authorized real send because that would require an external provider action; the component regressions exercise the exact callback and storage-result sequences without sending. The optional contact-event origin metadata limitation documented in correction-1 security review remains unchanged and outside this reproduced path.

Fresh Astra review should read the original plan/handoff, both correction plans and handoffs, both prior Astra reviews, and all security/Bugbot reports. Inspect the complete uncommitted diff, with special attention to `viewerAuthority`, entry-time stale callback rejection, A to B to A completion rejection, status failure retention, coalescer trailing-read semantics, and the corrected test mock signature. Verify root's final full-unit/build results before deciding the keeper verdict. Request affected security and Bugbot re-review. Do not commit, push, promote, invoke no-mistakes, file Linear, or touch production.
