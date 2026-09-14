# PRP-470 correction cycle 1

Date: 2026-09-13. Implement through a fresh Sol-medium manager with Terra/Luna scopes, then fresh Astra review. Worktree and branch remain `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/6/AXIS-2`, `akhil/prp-470-inbox-loading`; base/current HEAD is `7b3d464fe2f102a527949044fc0289513d50029f` plus the reviewed uncommitted diff. Read the original plan, handoff, review, required security/bugbot reports, and applicable repo documents first.

## Required implementation

1. In `pro-unified-inbox.tsx`, bind SMS authorization-halt state to the same monotonic viewer generation as SMS results. Check captured identity/request validity immediately after fetch resolves, before any status-triggered mutation; retain the post-JSON check. A previous viewer's401/403 must neither halt the new viewer's poll nor prevent initial readiness/retry. Reset stale halt state on an identity transition before starting the new viewer's request. Preserve the existing no-automatic-loop behavior for a current viewer's actual auth refusal; do not make Retry spin against forbidden endpoints.
2. Bind already-published/optimistic SMS contacts to their viewer generation. Clear previous-viewer SMS state or store it with an owner and derive/merge only matching current data. A successful empty B response must never retain A's saved name/phone as `pendingOptimistic`; a same-viewer newly created empty contact must remain present until its server round-trip completes. Include other local SMS state that can affect rendered ownership if source inspection demonstrates it needs the same reset. Do not infer contact ownership by names or phone coincidence. No send/API/schema redesign is needed.
3. Add `data-attr="communication-inbox-retry"` (or a matching established name) to the shared Retry Button. Keep the promise-returning handler, accessible loading/error UI and reduced-motion behavior.
4. Amend the implementation handoff's blanket Node22 claim. Preserve successful command results and clearly distinguish historical reported runtime from subsequent verified runtime. Use an explicit executable or `login: false` with a verified PATH for correction checks; record `process.execPath`/version once for the runner.

## Behavioral regressions and acceptance

Terra owns the narrowly scoped implementation. Luna owns additions to the existing readiness test file, coordinating any shared-file edits with Sol. At minimum add tests that would fail before these fixes:

- A pending SMS request, transition to B, B retryable failure, late A401/403, B Retry with valid response: B performs the request, reaches ready and shows only B data. Test a legitimate A auth halt followed by B login as well, so guarding late responses alone cannot leave an old latch behind.
- A successful empty saved SMS contact already published, transition to B with successful empty SMS: A's contact is absent throughout B readiness and completion. Also test same-viewer optimistic-contact preservation and A-B-A generation behavior.
- Resident enabled SMS deferred completion and retryable failure/recovery; resident old-viewer SMS completion cannot publish. These exercise the counterpart code actually changed and fill the obvious acceptance gap without duplicating every manager test.
- After a current viewer reaches ready, a background SMS failure preserves the usable list and selection. Verify disabled SMS still makes no gate-owned calls.

Maintain existing inbox/applications completion-order, merge/trash, unread, deep-link and polling regressions. Prefer deferred responses and observable DOM/request counts. Never weaken an existing assertion to accommodate a regression.

Restore the server on pinned port3009, with exact dev/test project `emstjswhotsnyksqhqyf`, SMS UI enabled, managed runtime/scheduler disabled. Existing task fixtures and browser session are sufficient; no real provider message and no data wipe. Exercise delayed manager list, failed load/Retry, existing contact deep link, resident enabled-SMS completion, and mobile list/deep-link. Preserve the stored draft; document the unchanged baseline composer limitation. Generate the Review URL again with `npm run sandbox:open -- /portal/communication/active` and confirm it is reachable.

Run affected regressions, lint/typecheck appropriate to the final diff, and required repository checks after substantive corrections. Do not repeat broad checks solely to relabel historical runtime. Report exact commands, versions and exits, retaining failures. Graph hook remains required after code changes; if the installed executable limitation recurs, report it without replacing global tools or mutating unrelated worktrees. Do not promote; full portal E2E/staging release QA is not waived.

Save an updated handoff with these findings mapped to changes and test results. Return to root for fresh Astra review and required affected security/bugbot re-review. No commit, push, PR, Linear mutation, protected-branch changes, production action, or no-mistakes invocation by the correction delegate.
