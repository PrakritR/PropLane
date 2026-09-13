# PRP-470 correction cycle 1 Bugbot review

Date: 2026-09-13. Independent bounded source/test re-review. Only this retained report was written. One expressly authorized temporary regression was created, run, and deleted. No browser/server/DB/provider action, source fix, commit, push, or release action occurred.

## Exact reviewed identity

- Worktree: `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/6/AXIS-2`.
- Branch: `akhil/prp-470-inbox-loading`.
- Base and current HEAD: `7b3d464fe2f102a527949044fc0289513d50029f`.
- Candidate: uncommitted working-tree diff against that HEAD.
- SHA-256 of `git diff --binary 7b3d464fe2f102a527949044fc0289513d50029f -- src tests`: `e915cb741c44458ea94005295e4047dc9828f9ae2ee32b302d64a99b1c1b8ff4`.

All eight tracked source/test changes were reviewed:

- `src/components/portal/pro-communication.tsx`
- `src/components/portal/pro-unified-inbox.tsx`
- `src/components/portal/resident-communication.tsx`
- `src/lib/manager-applications-storage.ts`
- `src/lib/portal-inbox-storage.ts`
- `tests/unit/resident-conversation-inbox.test.tsx`
- `tests/unit/unified-conversation-inbox.test.tsx`
- `tests/unit/unified-inbox-sms-poll.test.tsx`

Untracked additions reviewed in full, excluded from the tracked-diff hash:

- `src/components/portal/communication-inbox-initial-state.tsx`: SHA-256 `eea7d384a39695e42e9ffd8648ae231e8290fa4808d42c94ca88012bb22c6a03`.
- `tests/unit/inbox-initial-loading-readiness.test.tsx`: SHA-256 `d796289c8c1f2bae92c76397ed9bf02a248c939bc6c27726e2043f6727c464c9`.

Read root AGENTS, Akhil instructions, Communication contract, ship gate, original Bugbot and Astra review, and correction handoff. No `.graphify/graph.json` exists in this pool checkout; reviewed the area contract and source directly.

## Severity and disposition

- Critical: none established.
- High: none established.
- Medium / P2: one unresolved finding, B2 below.
- Original B1 / Medium: resolved in the recorded correction snapshot.
- Low: none newly established.

## Resolved B1: stale SMS authorization can no longer halt the next viewer

`pro-unified-inbox.tsx` checks captured viewer identity, viewer epoch, and initial request generation immediately after fetch, before any 401/403 latch side effect. Identity transitions clear accepted SMS contacts and reset the authorization latch in a layout effect. The normalized publication updater also verifies the owning epoch. Direct-send SMS refresh now uses this guarded loader.

Permanent regressions cover late A401/A403 after B's retryable failure, B's successful third-request retry, legitimate A authorization halt followed by B login, accepted and optimistic empty contacts across A-B-A, and stale successful SMS results. The same-viewer refusal stop behavior remains intact. Resident enabled-SMS deferred/error/retry and stale-response cases now have coverage. Retry carries the requested analytics attribute.

## B2 - Medium / P2 - stale direct-send email refresh erases the new viewer's accepted list

Locations: `src/components/portal/pro-unified-inbox.tsx:757-759`, interacting with the changed stale-result handling in `src/lib/portal-inbox-storage.ts:313` and the legacy wrapper at `src/lib/portal-inbox-storage.ts:347-351`.

`refreshAfterDirectSend` still calls the array-only loader and unconditionally publishes its returned rows. The new status-aware storage loader correctly returns `{ rows: [], ok: false, stale: true }` for A's obsolete request after an account transition. The compatibility wrapper strips `stale` and returns `[]`. If B's initial load has already completed, A's continuation consequently executes `setEmailThreads([])` in the retained component and removes B's accepted email conversations. It can also invalidate the selected email row. B's cache remains correct, and no cross-account server write or disclosure was demonstrated, but the visible ready list is corrupted until another refresh/store event repairs it.

The callback existed before this patch, but the new stale-result contract exposes this empty-publication path. It also falls within the explicit requirement that old viewer completions cannot mutate the new viewer's published rows. Fixing only SMS publication does not close the complete direct-send refresh path.

### Reproduction and evidence

A narrowly authorized temporary RTL test copied the existing readiness harness and replaced the direct pane with a button that invokes its real `onSent` callback. It mocked the legacy loader's deferred result to the exact `[]` produced by the real wrapper on a stale status; the existing passing storage tests independently verify that old-viewer requests return stale empty results.

1. Render A with a directory-only contact and select it.
2. Invoke the direct-pane send-complete callback, leaving its email refresh pending.
3. Switch the retained component to B and complete B's initial status loader with `B accepted email`.
4. Assert B's row is visible, then complete A's legacy refresh with `[]`.
5. Assert B's row remains. Actual: query returns null; the row disappeared.

Command:

```text
/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin/node node_modules/vitest/vitest.mjs run tests/unit/__prp470_c1_review_temp.test.tsx -t 'review probe keeps B rows' --no-file-parallelism
```

Result: exit 1; one failed, 20 skipped; assertion at temporary line 741 was `expected null not to be null`. This is a focused component reproduction with a faithful storage-result mock, not a browser reproduction or an end-to-end storage integration test. The temporary file was deleted immediately afterward.

Suggested correction: use the status-aware loader in this continuation and reject stale results before changing rows, selection, or URL. Capture and validate viewer generation at invocation and completion as well, so a send callback retained from A cannot begin or publish work for B. Add the permanent delayed-A/direct-send/B-ready regression. Inventory all asynchronous publication paths in this component: initial load, storage events, bulk callbacks, direct-send email and SMS, polling, contact events, and thread callbacks. Treat only concrete stale-owner paths as fixes; do not expand into a broad mailbox redesign.

## Independent existing-test validation

```text
/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin/node node_modules/vitest/vitest.mjs run tests/unit/inbox-initial-loading-readiness.test.tsx tests/unit/unified-inbox-sms-poll.test.tsx tests/unit/unified-conversation-inbox.test.tsx tests/unit/resident-conversation-inbox.test.tsx --no-file-parallelism
```

Result: exit 0; four files, 35 tests; 6.62 seconds. These include 20 readiness cases and verify B1 resolution. They do not cover B2. Full-unit/lint/build/browser evidence in the correction handoff was read but not independently rerun or represented here as this reviewer's execution.

Other checks: initial membership and selection remain gated; directory completion is wired through a stable parent callback; successful empty responses are distinguished from failed/malformed top-level payloads; nonforced initial requests reuse existing fetch joining; storage clears only its own in-flight promise; normal background SMS failures preserve a usable list. The directory completion unit harness remains simplified rather than mounting the actual manager parent.

## Verdict

Changes requested for B2. Original stale SMS authorization finding B1 is resolved. No Critical or High finding was established, but the viewer-owned publication acceptance boundary remains incomplete. This verdict applies only to the exact snapshot above and is not merge or release authorization.
