# Messaging bugbot review — 2026-09-07

## Reviewed revision and scope

- Reviewer: messaging-review bugbot subagent, read-only implementation review.
- Worktree: `/private/tmp/proplane-messaging-20260907`.
- Reviewed base: `origin/main` at `62a8975be7b699f37c088377faca59ed5c6af890`.
- Reviewed HEAD: `62a8975be7b699f37c088377faca59ed5c6af890`, plus the restored, **uncommitted** messaging diff. This is not a review of a later commit or production deployment.
- Production files: `src/components/portal/pro-inbox.tsx`, `src/components/portal/resident-inbox-panel.tsx`, `src/lib/agent-notify.server.ts`, `src/lib/agent/manager-inbox-agent.server.ts`, `src/lib/inbox-reply-outcome.ts`, and `src/lib/portal-inbox-delivery.ts`.
- SHA-256 of `git diff --binary HEAD --` those six production paths, in the order above, after the analytics follow-up reviewed below: `dc655c7544689b9d11a6f2d9d4ed757ddafa86e5aad1c9d62004a7dafaa387cb`.
- Reviewed corresponding changes to six tracked test files and the new `inbox-reply-persistence-failure.test.ts` and `manager-inbox-agent.test.ts`. New-file SHA-256 values: `c74f2c70f36c69b49daf185c945e2baaec9182d6a3284fb2816e42c02db1f141` and `c7d8f0ec01f614b6d669ab1d2b884befbcf7245cfadc493c860586a3d8028c9c`, respectively.

Current `AGENTS.md`, `docs/ship-gate.md`, and co-manager access guidance were checked. Existing assistant and observability architecture informed the review. Graphify query was attempted first in this worktree but its graph was unavailable; current source and the Git base were used instead. No graph was generated or changed.

## Gate result

**No Critical or High findings in the reviewed patch. No blocking regression found.** The patch can proceed through the remaining test, lint, and release gates. This report does not constitute staging QA or production promotion approval.

## Resolution evidence

| Defect addressed | Severity | Reviewed resolution and evidence |
| --- | --- | --- |
| A successful PropLane-only reply produces “Could not send reply.” | Medium | Manager and resident outcomes now carry `proplaneRequested` and `proplaneOk`; the shared toast builder includes the accepted channel. `cross-inbox-reply-integrity.test.tsx`, `resident-refused-send-not-delivered.test.tsx`, and `inbox-reply-outcome.test.ts` cover assistant-only success and partial outcomes. Existing email/text behavior and unknown-SMS warnings remain intact. |
| Resident rollback withdraws an accepted portal reply after another channel fails. | Medium | The catch gate now requires all three channels to have failed before rollback. The resident partial-delivery test preserves the accepted message and clears the draft while reporting email failure. This does not change recipient authorization or initiate an extra send. |
| An escalation changes the canonical assistant thread into a non-assistant routing type. | Medium | `notifyManagerFromAgent` consistently writes `agent_notice`, preserving the event subtype as message `noticeType`. `resolveInboxThreadReplyTarget` recovers existing records using exact owner-derived canonical ID and manager scope, after authorization. Tests cover typed escalation, foreign caller refusal, and a human named “PropLane Assistant.” Existing code has no reader depending on escalation values as thread types. |
| Manager assistant proposes an action with no saved approval. | Medium | The runner now persists the existing preview/input through `createPendingActionForUser`, with authenticated manager IDs, `portal: "manager"`, and server-generated `proposalTraceId`. Dashboard listing and confirmation retain user/portal scoping. `allowWriteTools: []` remains unchanged; no action executes inline. A failed insert produces failure copy rather than a dashboard approval promise. The new manager runner test verifies these fields. No fictitious inbox ID is inserted as an `agent_sessions` foreign key. |
| The current manager prompt is appended twice to normal sequential history. | Low | The matching trailing committed user turn is removed before the incoming turn is appended. Earlier distinct turns remain intact. The manager runner test asserts a single current turn. This is not an atomic solution for overlapping background turns. |
| Reply persistence failure is acknowledged as successful. | Medium | `commitInboxThreadReply` now checks its fresh-read and upsert errors and refuses a missing conversation. New persistence tests verify failed read, missing row, rejected upsert, and preserved history on success. Manager runner tests verify a rejected reply commit returns `replied: false`. Generic error copy avoids disclosing database details to the client. |

The legacy numeric-phone regression test exercises current base behavior: `manager-notification-routing.server.ts` already normalizes the value using `String(...).trim()`. The restored patch does not need to overwrite newer routing implementation to retain this regression coverage.

### Analytics follow-up re-review

The final follow-up moves `assistant_message_sent` after the awaited `commitInboxThreadReply`. A failed reply commit therefore emits `assistant_reply_failed` without a misleading success event. The manager runner regression now explicitly asserts both the absence of the success event and presence of the failure event on rejected persistence. The proposal event still follows successful proposal persistence, which is independently correct even if the subsequent transcript append fails. No authorization, confirmation, or delivery behavior changed in this follow-up. No blocking finding.

## Cache, performance, and web/native parity review

- **Cache and egress:** No cache keys, TTLs, coalesced refresh guards, invalidation events, or public cache headers change. Both panels retain their existing forced reconciliation calls; the patch introduces no extra client fetch or polling loop. Reply persistence checks inspect the results of existing queries rather than adding database round trips. The manager runner adds a pending-action insert only when the model actually produces a proposal, using the existing persistence helper.
- **Rendering and bundle behavior:** The client changes carry two outcome fields and consolidate resident toast construction into the existing small shared utility. They introduce no server imports into client code, new UI dependencies, layout, images, fonts, list rendering, or RSC boundary changes. Notification subtype preservation adds only a scalar to each typed notice. History remains bounded by the existing limit.
- **Server work:** Manager events use the existing fail-soft analytics transport. The new pending write occurs in the existing deferred inbox-agent turn, so it does not extend the immediate send acknowledgment's model-processing path. The unchanged shared transcript read/merge/upsert cost and concurrency limitations are recorded below, not claimed as fixed.
- **Web/native parity:** The six production files contain no navigation registry, route, deep-link, push payload, native shell, upload, safe-area, or layout change. The native WebView and website use these same portal components and server endpoints, so the corrected outcomes apply to both. Existing push destinations are untouched. No parity registry or native asset update is required by this diff. This is a code-scope review, not a device/browser execution claim.

## Current-main interactions and residual findings

These are **pre-existing, unresolved limitations**, not defects introduced by the restored patch. They must not be described as fixed by this landing.

1. **Medium — co-manager assistant context differs by surface.** `src/lib/tools/context.ts` now resolves `managerSmsAccess` with `resolveManagerSmsAccess` for signed-in portal chat. The separate `resolveManagerInboxAgentContext` in `src/lib/agent/manager-inbox-agent.server.ts` still omits it, including in the reviewed base version. A pure co-manager can receive empty owned-portfolio results in Communication while the popup/SMS assistant sees assigned houses. This is under-scoping, not a demonstrated cross-owner disclosure. A follow-up should use the same session-independent access resolver with the authenticated actor as both actor and own-number owner, and test assigned-house reads plus permission revocation. Restoring this patch does not erase the newer main resolver.

2. **Medium — resident assistant can acknowledge a message but never answer.** The existing resident runner requires a stored/legacy manager binding before the model runs; canonical threads can be created without one, and existing bindings are not refreshed when a relationship becomes stale. Resident proposals also have no reachable resident approval-list UI. These paths are outside this patch.

3. **Medium — broader delivery acknowledgment remains incomplete.** The unchanged send route can return success for email/SMS-only delivery without an accepted provider send. `deliverPortalMessageThreadSide` also still ignores database errors. The new strict acknowledgment applies to `commitInboxThreadReply`, not all message storage or providers. A successful assistant-thread send response acknowledges persisted input and scheduled processing, not successful model completion.

4. **Medium — duplicate and concurrent transcript writes remain possible.** A reply targeting a stored `folder: "sent"` row is appended by the route's initial commit and can be appended again when the sender-side helper finds that same scope/owner/folder/counterparty. An active inbox row does not match that sent-side lookup, so this finding does not apply to every reply. Read/merge/upsert remains non-atomic, and a delete between the final read and upsert can still be resurrected. Shared stable message identity and atomic append are separate follow-ups.

Canonical recovery does not permit delegated access to run the owner's bot: `/api/portal/send-inbox-message` still requires `replyTarget.ownerUserId === user.id` for that branch. Foreign/inadequately permitted human-thread sends still pass the existing recipient-scope gate before commit. Pending confirmation resolves current authenticated context and revalidates the stored action; this patch does not alter that gate.

## Verification and limits

- `git diff --check` passed during this review.
- Changed implementation, new tests, current route interactions, pending-action persistence/confirmation, notification subtype consumers, and current co-manager access code were inspected.
- The reviewing subagent did not execute the test suite, lint, browser QA, production requests, or external sends. The root agent owns fresh validation for this base; earlier test counts from the pre-stash workspace are not asserted as results for this restored worktree.
- Only this report was written by this reviewer. Any subsequent production-code changes require an affected-scope re-review and an updated revision/diff identity.

## Staging QA follow-up — mobile composer clearance

### Additional reviewed revision

The original messaging patch has now landed as `989120505af8d3747f7c02bbf278b8e626c91a1a`. This follow-up reviews that HEAD plus the uncommitted `src/app/globals.css` change and new `tests/e2e/communication-reply-composer.spec.ts`. It does not replace the earlier base/diff identity with an assertion about unrelated changes.

- SHA-256 of `git diff --binary HEAD -- src/app/globals.css`: `4e9742b6898c3edd86d578105b6464d36a2ffbf28017387f6aeacfe8b3e3845c`.
- SHA-256 of the final new E2E file, limited to route-settled composer click/focus checks: `d9876f83a053f7caf61d3d4fdb1c6456669b54155e815c608ac62b681524ff00`.
- `git diff --check` passed on this follow-up.

### Finding and resolution evidence

**Medium — a phone composer becomes unreachable when a portal banner consumes vertical space.** The root agent reported reproducing this on staging in a real browser: the fixed bottom navigation covered the reply composer when the manager setup banner was present. The mobile thread-reading rule independently sized `.portal-main-inner` from `100dvh`, ignoring the height already consumed by its parent's sibling banner, and zeroed the main container's bottom-nav clearance.

The reviewed change restores the existing measured `--portal-native-bottom-nav-inset` as the main container's bottom padding and lets the inner flex child use available parent height (`height: auto; max-height: 100%`). This matches the surrounding shared fixed-chrome flex rules and their `min-height: 0` contract. The rule is limited to thread-reading at widths below 1024px. Desktop and non-thread surfaces retain their existing sizing; no per-panel bottom offset, extra observer, fetch, or native-specific duplicate UI was introduced.

The root agent reported that injecting these declarations in the failing browser moved the composer up by the banner's 54px and restored actual clicking. That is reported browser evidence, not a browser run independently performed by this reviewer. The final authenticated E2E case waits for the selected conversation URL, inserts a 54px non-shrinking sibling banner, and tests actual composer click/focus at 375, 768, and 1280px. It uses the seeded manager login rather than `/demo` and sends no message. The combined 503 assertion was removed after an unexplained no-request failure; this final spec does not verify Send, error toasts, or draft retention.

**No new blocking bug or security regression found in this follow-up.** The CSS adds no data access, identity, or authorization change. It reuses the inset already measured for browser and Capacitor bottom navigation; existing safe-area handling in the thread header/composer remains intact. There is no route, navigation registry, deep-link, push payload, or native asset change. Code review supports shared web/native behavior, but this E2E case does not exercise an iOS/Android virtual keyboard, nonzero device safe areas, or resident/vendor sessions. Fresh browser/test execution remains with the root agent.

### Follow-up test failure under investigation

The root agent subsequently reported that the built-localhost test passed actual composer clicking at all three widths, whereas the old CSS had failed with navigation intercepting the click. The final Send click initially produced no request or toast. A manual browser run of the fixed build successfully received the intercepted 503 and retained the draft, and its form passed `checkValidity()`. The final E2E was bounded to the independently reproduced CSS reachability defect: it waits for the selected conversation URL and tests actual click/focus only. The root agent reports that final case passed in 7.1 seconds, the rebuilt CSS build succeeded, and 8,434 unit tests passed. These are root-reported validation results, not runs executed by this reviewer. Independent manual/staging intercepted-503 checks passed, but the combined automated Send/503 case did not pass and is not represented as passing.

**Medium, pre-existing — synthesized assistant placeholders can silently ignore Send before stored-row hydration.** Source inspection found a concrete path consistent with that symptom: `resolveCommunicationInboxThread` can return a canonical assistant placeholder absent from the raw inbox rows, so the composer renders. `handleReply` in `pro-inbox.tsx` then searches only `localRef.current` and returns without an outcome when that row is absent; `sendActiveReply` silently returns on that missing outcome. This yields no network request, no toast, and an unchanged draft. The reviewer reported this immediately to the root agent. Correlating the failed browser trace's inbox-load timing and row contents is still needed to identify it as the cause of that particular failure. Waiting for a URL alone does not prove stored-row hydration, and no placeholder-send correction is included in the reviewed CSS patch.

### Separate staging configuration failure

The root agent also reported a real bot turn failing because staging inherited an invalid preview provider API key, then replacing it with a branch-scoped staging development key through Vercel. No key material was inspected, recorded, or changed by this reviewer. This is separate from composer reachability and the stored-message acceptance fixes. A successful bot response after the resulting staging deployment is still needed to establish resolution; an environment update or an intercepted-response E2E test alone is not that evidence.

Final handoff: the root agent is landing the bounded CSS correction through main and staging. The placeholder silent-return issue above remains unclosed; hydration causality for the failed combined test remains tentative. Production remains held until dedicated QA clears the remaining concerns.
