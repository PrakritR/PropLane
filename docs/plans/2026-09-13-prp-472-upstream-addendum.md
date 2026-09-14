# PRP-472 upstream integration addendum

Astra read-only planning update, September 13, 2026. Read with `2026-09-13-prp-472-plan.md` and `2026-09-13-prp-472-safety-addendum.md`. Those acceptance, observation, authorization, migration and dev-only restrictions remain in force. This document adds a prerequisite integration step, not a replacement architecture or release authorization.

## Pinned baseline and decision

- Original shared baseline: `7b3d464fe2f102a527949044fc0289513d50029f`.
- Reviewed PRP-470 dependency and current PRP-472 HEAD: `8cfe3491372515bb2acd96a346ce688047a83ca6`.
- Pinned upstream main: `203d5e58f3ad99e6a977d65b1bbdb69115c52711`, 51 commits beyond the original baseline.
- Keeper: `akhil/prp-472-inbox-unread`, pool 6 at `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/6/AXIS-2`. Read-only status during planning was clean, ahead 1 / behind 51 relative to its existing upstream tracking reference. That tracking reference is not a push destination instruction.

Integrate pinned main before implementing PRP-472. Keep both histories with a normal merge onto this keeper. Rebase/cherry-pick would rewrite the reviewed dependency or obscure the upstream integration, and implementing on the old baseline would defer the same conflicts until the read-state change is harder to isolate. No branch promotion, force push, production mutation, PR, or no-mistakes invocation is authorized by this addendum.

Fresh Sol-medium should manage Terra conflict resolution and Luna's independent contract/test inventory, with disjoint ownership. Root's read-only merge preview found exactly five conflict files: `pro-unified-inbox.tsx`, `resident-communication.tsx`, `manager-applications-storage.ts`, `portal-inbox-storage.ts`, and `tests/unit/unified-conversation-inbox.test.tsx`. A merge was not initiated by this planning task.

Use a pinned `--no-commit` merge for inspection, resolve and run the focused integration checks below before layering PRP-472 edits. Prefer an integration-only merge commit after those checks so its two parents and resolution diff are an immutable review baseline; final fresh Astra review still covers that integration and PRP-472. If local process holds commits until review, record the resolved tree and exact integration diff before any PRP-472 edits, then preserve the two-parent merge boundary when committing. Do not leave a single undocumented combined merge/read-fix diff. Record both parent SHAs, resolved baseline/tree SHA, five-file resolution inventory, any extra integration fixes, and final HEAD in the Sol handoff. Stop if the checked-out keeper/HEAD differs unexpectedly. Do not chase a later main tip mid-cycle without another drift assessment.

## What remains broken

Pinned main does not implement PRP-472. `pro-resident-detail-inbox.tsx` has no diff from the original baseline. `pro-unified-inbox.tsx:871-883` still passes `smsResident` using only `resident.residentEmail === directChatEmail`, and still provides only `onSent`, not an observed-read callback. Consequently an exact selected native SMS binding with `residentEmail: null` is still omitted from the combined pane, and that pane still bypasses the standalone panels' read actions. This is source confirmation against root's existing real-data reproduction; this task did not run another browser or claim a new reproduction.

The new upstream `change_portal_inbox_thread_folders` RPC is an archive/restore operation. It intentionally changes folder/previousFolder and clears unread on archive; it accepts neither an observed snapshot nor exact JSON/timestamp preconditions. Its existence does not supply a generic safe read acknowledgement. Keep the safety addendum's separate, additive, service-role-only, invoker RPC with exact database-row JSONB and timestamp CAS. Do not add a read mode to the folder RPC, call archive/restore to mark read, or substitute it for the long-history-safe POST observation contract.

## Resolution inventory

### `src/components/portal/pro-unified-inbox.tsx`

Use reviewed PRP-470 as the readiness/async authority. Preserve its `initialListState`, successful status results, application-directory gate, stable `onApplicationsLoaded`, viewer authority/epoch checks, A -> B -> A handling, old-callback rejection before starting refreshes, latest direct-send generation, and coalesced forced email refresh. Upstream's separate `emailReady`/`smsReady`/`persistedInboxReadSucceeded` scheme releases the list without applications and is not a replacement. Do not retain two competing readiness effects, retry counters or loading UIs. Keep the existing PRP-470 initial-state component and usable-list behavior on background failure.

Apply upstream UI changes around that state machine: Status filter (`read` means active rows whose merged unread is false), removal of the segment rail and floating bulk bar, per-row `CommunicationRowActions`, and email `memberKeys` derived from `sourceThreadIds`. Preserve action handlers and full merged membership. A source ID retained for archive coverage is still display/action membership, never proof of a PRP-472 GET observation or authorization.

Route the SMS network read through upstream `loadManagerSmsConversationsClient`. Preserve PRP-470's generation checks before publishing and before interpreting stale auth failures. IMPORTANT: this new 17-line helper has **no TTL**. It shares in-flight requests and queued forced follow-ups per viewer, and clones each Response for independent body readers. `createCoalescedRefresher` has no settled-response cache. Preserve existing polling cadence and inbox/application success TTLs; do not describe this integration as adding SMS TTL or introduce a new SMS cache in this ticket.

Do not mechanically replace `loadSms(requestGeneration?: number)` with upstream `loadSms(force = false)`: the arguments mean different things. Use named options (or two distinct arguments) for initial generation and freshness. Initial/poll reads can join current work; post-send/contact-write refreshes must request a forced follow-up so they cannot join a request started before the write. Keep stable local opened-ID notification free of network reads. A retained old viewer callback must fail before invoking the shared helper; clearing its map alone does not cancel old promises or their queued follow-ups.

After resolving integration, implement selected-key SMS resolution and observed-read wiring from the safety addendum. Test Status=Unread and legacy `/unread` deep links as well as Active. Clearing the badge may remove the list row; it must not open another conversation or run an acknowledgement loop. Status=Read must include the newly read row using the same merged unread calculation.

### `src/components/portal/resident-communication.tsx`

Keep PRP-470's session/status/generation gate, error/retry UI and source-ready rendering. Layer upstream Status filter state/prop, read-only result filtering, row action menus, and removal of the rail/bulk bar over it. Here `readOnly` is the upstream **read-message filter**, not a permission flag; do not interpret it as access authorization. Keep its current name for the bounded merge unless a necessary focused fix warrants renaming. Preserve resident pane behavior and the upstream one-row composer changes in its separate panel file.

### `src/lib/portal-inbox-storage.ts`

Retain PRP-470 `PersistedInboxSyncResult`, `syncPersistedInboxFromServerWithStatus`, array-only compatibility wrapper, current-generation stale result, success-only GET TTL, same-promise cleanup and no success timestamp from local staging/writes. Do not restore upstream `inboxLastSyncedAtByKey` writes from `commitInboxMemory`/`persistInbox`, which would let synthetic/local rows satisfy server readiness.

Keep upstream `changePersistedInboxThreadFolders` unchanged in purpose and preserve the automerged metadata-only archive/restore callers. Resolve readiness compatibility into one state source: upstream `persistedInboxReadSucceeded` may be retained as an adapter if still consumed, but must reflect the current viewer's successful server read, not local cache existence. The final manager initial-load owner must use the returned `ok/stale` result. Avoid parallel booleans that can disagree with the status API. A current failed refresh must invalidate eligibility for a subsequent unforced success-TTL hit; keep the last usable rows while reporting failure. Stale failures must not invalidate the current generation. Check this behavior explicitly during integration.

PRP-472 response-only `readSources` must survive normalization and both collapse passes without being sent back by whole-row mutation writers. Do not use upstream `sourceThreadIds` as observations. Concurrent archive must defeat an old read CAS, and read reconciliation must preserve the archived cache state.

### `src/lib/manager-applications-storage.ts`

This file cannot be resolved wholesale to either parent. Preserve PRP-470 `ManagerApplicationsSyncResult`, WithStatus loader, compatibility array wrapper, post-body generation check, current-cache union merge and successful-server timestamp distinct from local writes.

Also preserve upstream `portalSessionViewerId()` fallback in `ensureApplicationsScope` and the loader, and same-viewer session-hydration reset avoidance. An explicit request for actor A followed by session hydration confirming A must continue/coalesce; switching A -> B -> A must still invalidate old work. This is viewer identity normalization, not a new property/workspace filter. No new workspace-filter parameter or server query filter appears in the pinned file diff; keep existing `managerUserId` and `selfScope` semantics.

Retain the exported `managerApplicationsReadSucceeded(managerUserId?)`: upstream `pro-residents.tsx:648` now calls it before releasing the resident directory, and tests exercise it. Back it with the same current-scope successful-read state as WithStatus. Current 401/403, network, malformed or non-OK response must report false and permit immediate retry without losing the last usable snapshot where allowed. An older generation's failure cannot clear current readiness. Do not remove this export merely because PRP-470 inbox itself consumes WithStatus. Keep browser-only session listener registration guarded: this module also exports pure helpers imported by server code.

### `tests/unit/unified-conversation-inbox.test.tsx`

Preserve PRP-470 session readiness/application/WithStatus mocks and asynchronous first-load expectations; preserve upstream read/unread/archive filter, no-rail, mobile filter stability and row-action assertions. Do not make the test green by dropping either feature's assertions or mocking a successful load independently of its returned status. The rest of PRP-470 readiness coverage remains authoritative.

### Automerged files needing semantic inspection

- `pro-communication.tsx`: retain upstream Status filters/chips, viewer-scoped composer SMS directory and shared SMS reader, plus PRP-470 stable `refreshDirectory` and `onApplicationsLoaded` wiring. Its current string-only viewer ref is not equivalent to PRP-470 A -> B -> A authority. Extend the bounded viewer-generation guard if integration tests expose stale recipient publication, with a focused regression.
- `communication-inbox-thread-mutations.ts`, `use-unified-communication-bulk.ts`, `portal-inbox-threads/route.ts`: keep upstream ordinary archive/restore RPC, full source expansion, notice-specific archive path and authorization preflight. Add the observed-read action alongside them in the existing route. Read failure may not fall back to folder mutation or whole-row upsert.
- `portal-inbox-ui.tsx`, `inbox-composer-tools.tsx`, `pro-inbox.tsx`, `resident-inbox-panel.tsx`, `vendor-inbox-panel.tsx`: preserve upstream row-menu support, single reply-row AI/channel controls, mobile sheet behavior, channel unavailable reasons, and Add email/Add phone entry points. No composer redesign is needed for PRP-472.
- `docs/agents/communication-inbox.md`: preserve reviewed PRP-470 loading invariant and upstream Status/row-menu/composer documentation without duplicating a second contract. Shared AGENTS safety continues to win over conflicting older prose.

## Focused integration checks before PRP-472 edits

Run the merged baseline's normal type/lint checks and targeted behavioral suites, with exact commands/exits in the handoff. In addition to PRP-470 `inbox-initial-loading-readiness`, `unified-inbox-sms-poll`, `resident-conversation-inbox` and `unified-conversation-inbox`, include:

- `portal-source-readiness`, `manager-applications-cold-cache`, `manager-applications-merge-rows`, `resident-directory-stages`: compatibility export, hydration coalescing, failed-refresh retry, generation and directory completeness.
- `communication-status-behavior`, `communication-segment-parity`, `communication-row-actions`, `inbox-archive-demo-and-sources`, `communication-notice-archive`, `inbox-folder-route`: upstream filter/archive/membership behavior survives resolution.
- `inbox-composer-channel-menu`, `inbox-composer-row-parity`, `manager-inbox-reply-channels`, and relevant `coalesced-refresh` tests: upstream shared controls and freshness guarantees.

Add a focused SMS-reader test only where existing coverage is absent: two simultaneous list/composer consumers receive independently readable clones from one fetch; forced post-write refresh is a later fetch; old viewer results cannot publish into A -> B -> A or latch current auth. No artificial resolved-response TTL expectation. Add applications/inbox failure-after-success and next-unforced-retry cases if current tests do not cover them.

After PRP-472 implementation, run its full original/safety matrix plus all affected integration suites and repo-required unit/lint/typecheck/build gates. Fresh Astra review should compare (1) merge resolution against both parents, including `--remerge-diff` or the saved resolution inventory, and (2) PRP-472 against the resolved integration baseline. Existing PRP-470 review is evidence for its original commit, not proof the merge preserved it.

Root/Sol browser QA should reuse the bounded dev fixtures already prepared: delayed email/applications/SMS source readiness, merged explicit-key SMS with no email, unread -> read Status transition, re-open/reload/new arrival/hidden tab, merged archive/restore, and the one-row composer at desktop and 390px. Do not repeat the entire historical investigation. No provider send is needed. The migration probe still requires observed-read grants/CAS/50- and 150-message histories and the deterministic concurrent append test from the safety addendum.

## Migration drift and limits

Upstream now contains `20260912233000_atomic_inbox_folder_changes.sql`, defining two archive-related service-role functions. Merging source does not authorize applying that or any other upstream migration. Preserve root's private remote-ledger workdir approach from the safety addendum: reverify exact dev project and remote history, copy only the reviewed new observed-read migration, compare source hash, and require the dry run to name exactly that migration with no seeds/roles. Existing folder RPC availability may be probed read-only. If merged archive QA reveals a missing upstream function, report it as a concrete dev-schema dependency for root to resolve; do not silently broaden the apply set or misdiagnose it as the new read RPC.

The graph query ran successfully but reported `graphify-out/graph.json`, whereas repository instructions name `.graphify`; it was used only for orientation. Pinned git source/diffs above are the authority for drift. No graph rebuild was needed for this documentation-only planning task. It changed no source, git state, database, browser, server or Linear item. The only written artifact is this addendum.
