# PRP-470 correction cycle 2

Date: 2026-09-13. This is the last automated correction cycle permitted by the feature-cycle contract. Execute through fresh Sol-medium with Terra implementation and Luna regression ownership, then fresh Astra review.

Worktree: `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/6/AXIS-2`. Branch: `akhil/prp-470-inbox-loading`. Base/current HEAD: `7b3d464fe2f102a527949044fc0289513d50029f`, plus the complete uncommitted implementation. Read the original plan, both handoffs, correction-1 review, and correction-1 security/Bugbot reports. Preserve all existing task work and fixtures.

## Problem and required correction

`refreshAfterDirectSend` in `src/components/portal/pro-unified-inbox.tsx:758` still uses the legacy array-only inbox loader and unconditionally calls `setEmailThreads(rows)`. The new storage layer correctly returns `{ rows: [], ok: false, stale: true }` for an old viewer, but the legacy wrapper removes that status. Consequently an A direct-send refresh completing after B's initial load erases B's displayed email rows. Bugbot reproduced this through the real callback using a temporary behavioral regression; it exited 1 and was deleted. The SMS half of this callback was corrected in cycle 1; its email half was not.

Use the status-aware existing inbox loader in this callback, retain `ok`/`stale`, and bind the operation to its initiating viewer and monotonic generation. Check validity before publishing rows, selecting a resulting email thread, or changing the URL. An obsolete callback invocation must not apply its captured contact/route context to a different current viewer. A stale or failed refresh leaves the current usable list and selection intact. Successful same-viewer refresh still reveals the sent thread and resolves a directory-only contact to that thread. Keep the SMS half on the guarded loader.

Preserve shared TTL/in-flight behavior. The existing callback forces refresh; any retained forced path must comply with the repository's scoped `createCoalescedRefresher` rule, reusing an appropriate existing helper where available. Do not add a second raw fetch, broad portal prefetch, fixed delay, or unconditional force on initial mount. Keep legacy array exports compatible for their other consumers.

## Publication inventory to verify before handoff

Record the final disposition of each path, including why an unchanged path is safe for this correction. Do not claim all direct-send publication is guarded based only on SMS.

| Surface | Current paths to inspect | Required boundary |
| --- | --- | --- |
| Manager initial email/applications | `loadInitialList`, lines 378-400 | Successful current generation only; refresh parent directory with readiness |
| Manager cache/event/assistant | Lines 288-315 | Synchronous current-viewer cache reads; provisional data remains hidden |
| Manager SMS | `loadSms`, layout reset, polling, contact event, direct-send SMS refresh | Guards before auth effects and row publication; current-viewer optimistic retention |
| Manager direct-send email | Lines 757-775 | Preserve result status and viewer/generation through rows, selection, URL |
| Resident initial email/SMS | `loadInitialList` and `loadResidentSms`, lines 173-225 | Successful current generation only; failed refresh cannot reveal stale data |
| Resident cache/event/assistant | Lines 145-170 | Current-viewer cache and hidden provisional data |
| Both bulk callbacks and child callbacks | `onEmailThreadsChange`, selection/route callbacks, `useUnifiedCommunicationBulk` | Inspect downstream asynchronous completions for impact from the changed read API; report unchanged write behavior separately rather than silently certifying it |

The optional contact-event payload has no origin identity, but current production producers send no optimistic payload. Do not expand this correction into a hypothetical event API redesign. No provider send, schema, RLS, attachment, or native registry change is required by the reproduced defect.

## Tests and verification

Add permanent observable regressions for A direct-send refresh pending, B initial list ready, then A stale completion: B's row, selection and URL survive. Cover A-B-A so equal viewer strings cannot admit an older generation. Cover a same-viewer failed refresh preserving rows and successful direct-send refresh resolving the placeholder contact. Assert request counts for any coalescer change. Mocking the direct pane's authorized `onSent` callback avoids sending messages; the storage stale-result shape is already independently covered.

Retain the 20 readiness cases, SMS auth/optimistic isolation, completion-order, resident SMS, background refresh, merge/trash and existing inbox suites. Run the narrow regressions first; complete repository checks appropriate to the final source diff with the explicit Node22 executable and exact exits. Do not repeat checks merely to relabel runtime. Run the required graph hook and document its installed-executable limitation if unchanged; do not repair global tooling or another worktree.

Root owns the dev server on pinned 3009, exact dev/test project `emstjswhotsnyksqhqyf`, SMS UI enabled and runtime/scheduler disabled. The reviewer just verified mobile base loading to nine rows and 503 Retry recovery to nine rows. Reuse this evidence where unchanged; browser-check any direct contact/selection behavior affected by this correction with existing fixtures, without sending a provider message or editing the preserved draft. Root may restart the same server if needed. Generate the Review URL and confirm reachability.

Save `docs/plans/2026-09-13-prp-470-correction-2-handoff.md` mapping the finding, publication inventory, changes, command exits, browser evidence, and remaining limits. Return to root for fresh Astra and affected security/Bugbot re-review. No commit, push, PR, Linear, protected branch, production, staging, no-mistakes, data wipe, or unrelated worktree changes by delegates. Full portal E2E and staging release QA remain release gates, not waived by this keeper task.
