# Assistant batch bug review — 2026-09-06

Reviewed base: `8e0893359f0daa33acf3e416e50fe391e245d942` (main).
Reviewed head: working-tree batch before commit in `/private/tmp/axis-feature-batch-20260906`.
Scope: manager/resident/vendor chat route merges, pending-action rate limiting,
assistant task context, shared conversation transport, and associated tests.
Account deletion and UI layout are outside this review's scope.

## Findings and resolutions

- High, resolved: incoming route/helper conflict sides used a synchronous rate-limit
  interface while main now has an asynchronous limiter. Retained main's awaited
  implementation and tests in all three role routes and the shared decision helper.
- High, resolved: automatic merge silently duplicated exported context constants and
  functions, breaking compilation. Removed obsolete duplicate definitions, retaining
  the new Pacific clock and existing untrusted-context boundaries.
- Medium, resolved: the new clock prompt prohibited another year unless explicitly
  named, contradicting relative dates across New Year and tool-grounded historical
  dates. Clarified those exceptions without changing the Pacific date anchor.
- Medium, referred to parent for financial review: successful expense confirmation
  requests `syncManagerOutgoingExpensesFromServer(true)`, but that helper reuses any
  in-flight request, including one started before the confirmed write. Forced refresh
  must queue a subsequent request and retain viewer scoping. This report does not
  claim that helper is fixed.

## Verification

49 tests passed across `assistant-turn-context`, `pending-action-decision`,
`assistant-conversation-context-send`, `assistant-conversation-confirm`,
`assistant-conversation-disposal`, and `assistant-conversation-history` suites.
These cover separate internal context, standalone typed confirmations, retries,
duplicate sends, disposal, archive behavior and confirmation-only finance events.
No unresolved Critical or High finding remains in the reviewed assistant scope.

## Follow-up: main CI smoke failure

Reviewed failed run `34003793768`, head `8e0893359f0daa33acf3e416e50fe391e245d942`.
Eight smoke cases passed; `public-home.spec.ts` failed because raw CSS selected
both a visible FAQ and React's transient hidden streaming copy. The downloaded
trace's `after@call@74` snapshot places FAQ under `BODY > DIV[hidden][id="S:1"]`;
`after@call@76` places the rendered FAQ under the public `MAIN`. Source renders
`FaqSection` once. This is a test locator race against streaming hydration.

Resolved the FAQ and closing CTA using accessible named region locators, and
scoped hover/mobile note locators to the same FAQ region. Two visible FAQ regions
would still fail strict resolution. Seven question/answer pairs, order before
CTA, tilt/hover behavior, reduced motion, and phone overflow assertions remain.
No retries, skips, assertion removal or `.first()` workaround was added.
Production-mode local verification passed all nine smoke tests in 10.2 seconds
using Node 22 and the built server on port 3010, with zero retries. This includes
the previously failing FAQ, hover, reduced-motion, phone, and auth redirect cases.

Financial reviewer follow-up: the outgoing-expense helper now uses a viewer-scoped
coalesced refresher and tagged sync events. The panel no longer duplicates the
transport's forced refresh after confirmation; finance-focused checks passed.

## Additional promotion browser coverage

All eight desktop/mobile promotion tests passed in 17.2 seconds against the
production-mode build (Node 22, port 3010). The broader spec initially exposed
outdated test contracts, corrected after inspecting rendered output and source:

- Header Close replaced the removed footer Cancel button.
- Successful generation opens the generated View preview; assert its heading and
  Copy text control, close it, then verify the list gained exactly one record.
- Modern flat rows use selection checkboxes; the old promotion-row attribute was
  on the superseded asset-list component. Count the scoped record checkboxes.
- Desktop still asserts its Promotion heading; mobile source explicitly hides
  that title band, so both sizes assert the actual promotion list and New action.

Assertions for inline type switching, discard warning dismissal/acceptance,
cleared content, modal closure, and exact created-record count remain intact.
