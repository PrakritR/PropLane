# PRP-470 correction cycle 1 security re-review - 2026-09-13

## Scope and exact evidence

- Base and current HEAD: `7b3d464fe2f102a527949044fc0289513d50029f`.
- Reviewed the complete uncommitted `src`/`tests` diff: manager Communication and unified inbox, resident Communication, both storage modules, three modified existing test files, and both new source/test files.
- SHA-256 of `git diff --binary 7b3d464fe2f102a527949044fc0289513d50029f -- src tests`: `e915cb741c44458ea94005295e4047dc9828f9ae2ee32b302d64a99b1c1b8ff4`.
- New `src/components/portal/communication-inbox-initial-state.tsx` SHA-256: `eea7d384a39695e42e9ffd8648ae231e8290fa4808d42c94ca88012bb22c6a03`.
- New `tests/unit/inbox-initial-loading-readiness.test.tsx` SHA-256: `d796289c8c1f2bae92c76397ed9bf02a248c939bc6c27726e2043f6727c464c9`.
- Read root and Akhil instructions, the communication architecture, ship gate, original security report, and correction handoff. Inspected the unchanged session hook/latch, contact-event producers, bulk hook, and relevant inbox/application/SMS GET authorization boundaries. Neither `.graphify/graph.json` nor `graphify-out/graph.json` exists in this worktree; architecture documentation and source supplied the evidence.
- Independent static review only. This reviewer ran `git diff --check` with exit 0. Tests and browser QA recorded in the correction handoff were not re-executed by this reviewer. No source/test edits, server, browser, database access, external messages, commits, or pushes were performed. This report is the only file written by this reviewer.

## Prior findings and resolution

### SEC-470-1 - Medium / P2: obsolete SMS auth response halts the next viewer

Status: **resolved for the reported account-transition sequences**.

Evidence: `src/components/portal/pro-unified-inbox.tsx:248`, `:318`, `:328`, `:335`, `:343`, `:351`.

The loader captures viewer id and epoch, rejects obsolete responses immediately after `fetch` and before status handling, and retains the post-JSON epoch/request check. Its functional publication updater also checks the row owner's epoch. The layout effect clears the auth-stop ref/state on viewer transitions. Therefore an A 401/403 arriving after B's transition cannot stop B, and an already halted A does not carry its latch into B. A current viewer's real refusal still suppresses later automatic and manual SMS requests in that identity generation, preserving the intended auth-halt behavior.

Permanent behavioral regression assertions cover late A 401 and 403 followed by B Retry (`tests/unit/inbox-initial-loading-readiness.test.tsx:478`) and a legitimate A halt followed by B login (`:524`). These assert a new B request and B's visible contact, rather than merely inspecting internal refs. Their execution results remain attributed to the correction handoff/parent validation.

### SEC-470-2 - Medium: accepted empty A contacts survive into B

Status: **resolved for the reported accepted-state and optimistic-state carryover**.

Evidence: `src/components/portal/pro-unified-inbox.tsx:248`, `:251`, `:255`, `:350`, `:433`, `:438`.

The layout-phase identity transition empties SMS rows and assigns their ownership to the new epoch before paint. The old accepted empty-contact rows therefore cannot enter the next viewer's `pendingOptimistic` merge. Pending old network publications fail the epoch checks, including A-B-A. Same-viewer empty contacts still survive a server round trip. Contact-change refreshes and direct-send SMS refreshes use the guarded loader (`:461`, `:774`).

The regression at `tests/unit/inbox-initial-loading-readiness.test.tsx:558` first accepts A's saved empty contact and inserts an optimistic A contact, then switches to B and returns to A. It asserts that neither old row appears for B and that A's saved contact reappears only after a fresh A response. This directly addresses the original accepted-state disclosure sequence.

## Other security checks

- Inbox storage captures cache key and viewer generation before request dispatch, checks both before `notePortalResponse` and after JSON, rejects stale results with empty rows, and uses promise identity in `finally` (`src/lib/portal-inbox-storage.ts:295`, `:316`, `:321`, `:349`). The A-B-A request-slot and old-401 test assertions remain meaningful (`tests/unit/inbox-initial-loading-readiness.test.tsx:83`, `:103`). No new cross-viewer cache publication was identified in the changed loader.
- Application storage rejects old generations before status handling and after JSON, clears sensitive memory for a current 401/403, and only marks successful server completions as ready (`src/lib/manager-applications-storage.ts:787`, `:789`, `:796`, `:806`). Existing application cache `selfScope` semantics are unchanged. Both legacy array-only exports remain compatible; readiness status is additive and is not server authorization.
- Resident SMS does not mutate a global auth latch, rejects outdated generation completions, and replaces messages on successful load before revealing the list (`src/components/portal/resident-communication.tsx:173`, `:181`, `:212`). The enabled-SMS deferred and stale-viewer assertions cover this path (`tests/unit/inbox-initial-loading-readiness.test.tsx:638`).
- No server authorization, RLS, attachments, HTML rendering, provider sends, or write-authorization routes changed. Inbox GET still resolves authenticated scope and applies owner/participant filtering; applications GET derives its identity from the session; manager/resident SMS GETs derive identity and role server-side. Client readiness adds no authority.
- Retry introduces only a fixed analytics attribute and a promise-returning button callback. No PII is included by this addition.

## Limits and verdict

No new actionable security finding was established in the reviewed diff. **Security re-review passes for this bounded correction; SEC-470-1 and SEC-470-2 are closed as described above.** No unresolved Critical or High finding was identified.

One API boundary remains worth preserving explicitly: the optional optimistic contact event detail contains no originating viewer identity (`src/lib/manager-sms-messages.ts:15`), and the receiver captures the epoch when it receives the event. Current production dispatch sites supply no optimistic payload. This review therefore does not establish a currently reachable delayed old-account payload disclosure, but it also does not certify arbitrary future asynchronous producers of that optional detail. A future producer must bind its completion to its initiating viewer before dispatching contact metadata.

This verdict concerns the reviewed diff and the stated account-transition scenarios. It does not certify the entire pre-existing messaging system, same-identity session renewal, retained child-panel behavior, browser QA, or deployment readiness. Independent full-source review and validation remain separate release evidence.
