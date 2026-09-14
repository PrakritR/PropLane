# PRP-470 final affected security review - 2026-09-13

## Scope and candidate identity

Independent static review of the complete uncommitted source/test candidate against HEAD `7b3d464fe2f102a527949044fc0289513d50029f` in `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/6/AXIS-2`.

- SHA-256 of exactly `git diff HEAD -- src tests | shasum -a256`: `57361e92110827af71913df948d36345489b7ce76923d6cd031240bf6ff52d8d`.
- Untracked `src/components/portal/communication-inbox-initial-state.tsx`: `eea7d384a39695e42e9ffd8648ae231e8290fa4808d42c94ca88012bb22c6a03`.
- Untracked `tests/unit/inbox-initial-loading-readiness.test.tsx`: `1094d08a91e66631803cb30d8b91813bee484f80ea8c5b3886cf01b969b318ee`.

Reviewed all changed manager/resident Communication components, both storage modules, three modified existing test files, and both new source/test files. Read root/Akhil instructions, the Communication architecture, both prior security reports, correction-2 plan and handoff. Inspected the session hook/gate, coalescer, bulk hook and mutation helpers, contact-event dispatch sites, and the unchanged server read authorization boundaries. This worktree has no graph artifact according to the correction handoff; source and architecture documentation provided the review evidence.

This reviewer performed read-only inspection and wrote only this report. No tests, temporary probes, browser actions, database actions, builds, source edits, commits, pushes, or provider sends were performed. Test execution and browser validation remain attributed to the parent and correction handoff, not to this review.

## Findings and resolutions

No new actionable security finding was established in the reviewed candidate. The bounded affected security re-review passes.

| Finding | Severity | Resolution and evidence |
| --- | --- | --- |
| SEC-470-1: old SMS authorization failure halts the next viewer | Medium / P2 | Closed. `pro-unified-inbox.tsx:255` clears viewer-owned halt state; `:329` captures viewer/epoch and checks currentness immediately after fetch, before the auth halt, and again before publication. Deferred 401/403 and already-halted A to B regression assertions remain at `inbox-initial-loading-readiness.test.tsx:478` and `:524`. |
| SEC-470-2: accepted empty SMS contacts carry into another viewer | Medium | Closed for the reported accepted/optimistic-state sequences. `pro-unified-inbox.tsx:255` clears SMS rows in the layout identity transition and assigns their owner epoch. `:361` rejects old epoch publication, so old contacts cannot enter B's optimistic merge. The accepted and optimistic A-B-A regression remains at `inbox-initial-loading-readiness.test.tsx:558`. |
| Correction-1 stale direct-send email publication | Prior review's correctness finding; no new severity assigned here | Closed in the corrected callback. `pro-unified-inbox.tsx:768` preserves status and binds callback entry/completion to viewer authority and latest direct-send request generation. The acceptance check at `:797` precedes rows, placeholder resolution, selection, parent route callback, and URL publication. |

## Direct-send authority and A-B-A audit

`viewerAuthority` is a new object whenever the rendered viewer changes (`pro-unified-inbox.tsx:241`); the layout effect records the committed authority, increments epochs/request generation, and drops the viewer's refresher map (`:255`). A callback retained from the first A captures the first authority object. After committed B and then new A renders, the viewer strings match but the objects differ. Its entry check at `:776` returns before either the email or SMS refresh starts. A callback invoked under A but completing later similarly fails the authority check. The monotonic direct-send request generation additionally rejects earlier direct-send completions within one viewer.

The forced email refresh uses the existing `createCoalescedRefresher`, keyed by authority (`:784`). Repeated calls share one trailing refresh. Clearing the map does not cancel a previously queued read: that read may start under the then-current session, but the storage loader captures that actual session's cache identity and the obsolete callback still cannot publish its old contact/route context. No cross-viewer data publication was established through that queue.

Status failure, rejection, or `stale` prevents callback publication and leaves the displayed list/selection intact. Successful same-viewer refresh resolves the placeholder by its captured email and selects the returned thread. The fixed mock forwards the loader's second argument as options, so force/request-count assertions inspect the production call signature.

Permanent assertions cover A-to-B stale completion (`tests/unit/inbox-initial-loading-readiness.test.tsx:786`), A-B-A pending completion (`:834`), failure retention (`:871`), successful placeholder resolution (`:889`), bounded coalescing (`:910`), and retained A callback invocation after B (`:937`). A retained first-A callback invoked only after returning to A is supported by the source authority proof above, rather than a dedicated permanent regression. This review does not claim that exact combination was executed.

## Publication inventory and boundaries

| Surface | Disposition |
| --- | --- |
| Manager initial email/applications | `pro-unified-inbox.tsx:389` waits for all enabled sources, rejects obsolete initial request generation and stale results, and only publishes successful email/application completion. Directory rebuild is a stable parent callback. |
| Manager cache/event/assistant | `pro-unified-inbox.tsx:299` and `:304` synchronously read the current viewer-keyed cache. Assistant staging at `:310` is unchanged, including its queued microtask. Provisional list/selection is hidden by readiness (`:714`, `:732`). This is not a certification that arbitrary retained write-side staging is generation-safe. |
| Manager SMS | Initial, polling, visibility, contact-event and direct-send reads use `loadSms`. Auth effects and row publication have epoch checks; layout reset prevents accepted contact carryover. Current-session 401/403 continues to halt polling intentionally. |
| Manager direct-send email | Corrected status, authority and latest-request acceptance boundary covers rows and every resulting selection/URL effect. |
| Resident initial email/SMS | `resident-communication.tsx:173` checks SMS epoch/request generation before setting messages; `:194` checks initial request generation and inbox stale status. Successful current results are required before initial list/selection becomes visible (`:143`, `:339`). |
| Resident cache/event/assistant | Current-cache reads at `resident-communication.tsx:145`; unchanged assistant staging at `:153`. Provisional list and selected pane stay behind readiness. The same unchanged write-staging qualification applies. |
| Both bulk hooks | `pro-unified-inbox.tsx:721` and `resident-communication.tsx:330` still pass their setters to `useUnifiedCommunicationBulk`. Archive/restore/delete await successful writes before calling those setters; their mutation helpers also stage cache rows. These pre-existing asynchronous write paths do not consume the changed status read API and have no new viewer-generation retrofit in this candidate. They are excluded from a claim that every inbox publication is now account-generation guarded. |
| Child callbacks | Row-open and controlled-id handlers remain existing UI callbacks. Manager `ResidentDirectChatPane.onSent` at `pro-unified-inbox.tsx:983` uses the corrected callback. Existing child write completions and bulk close/route behavior were not rewritten or certified by this correction. |

The inbox storage loader captures cache key and viewer generation, guards before auth status handling and after JSON, and clears only its own promise slot (`portal-inbox-storage.ts:295`, `:316`, `:321`, `:349`). Application storage guards the scope generation before status handling and after JSON and keeps success freshness separate from local writes (`manager-applications-storage.ts:787`, `:789`, `:796`, `:806`). Legacy array-only exports remain compatible. Client readiness is never server authorization.

No server route, RLS, provider-send, attachment, or HTML rendering changes are present. Inbox GET derives authenticated scope and applies owner/participant filtering (`src/app/api/portal-inbox-threads/route.ts:35`, `:77`). Applications GET derives the session user and applies resident/manager read scope (`src/app/api/manager-applications/route.ts:557`). Manager and resident SMS GETs derive identity and role server-side (`src/app/api/manager/sms-conversations/route.ts:18`, `src/app/api/resident/sms-conversations/route.ts:13`).

The earlier optional contact-event origin limitation remains: all current production `dispatchManagerSmsContactsChanged` sites dispatch without an optimistic payload. A future asynchronous producer of that optional payload must bind it to its initiating viewer. No currently reachable new disclosure was established through those producers.

## Limits

This is a clean affected security review of the identified candidate and corrections, not certification of the whole pre-existing messaging system, all retained write callbacks, same-identity session renewal, browser QA, or release readiness. Parent-owned validation and release gates remain separate evidence.
