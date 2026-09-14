# PRP-472 correction 2 plan - September 13, 2026

## Authority and boundary

This is the final allowed automated correction under Akhil's feature cycle. Execute after root launches the fresh Sol-medium manager, with Terra/Luna delegates and a fresh Astra/security/Bugbot review afterward. Prior source remains frozen until that execution phase begins.

Keeper `akhil/prp-472-inbox-unread`, pool `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/6/AXIS-2`, HEAD `3c997bc4f09ef3b97c80cb559e8909830e164868`. Feature/correction changes are uncommitted. Correction-1 source aggregate: `74359f8b6b0f799f1976b018fb8b8ed976cad1c6b9dfcd1c4852edad642c6a6b`; root manifest `/private/tmp/axis-inbox-cycle/prp472-c1-source-freeze.json`.

Read AGENTS/Akhil, canonical feature-cycle document if absent in the pool, Communication/UI/local Next docs, original PRP-472 plan and safety/upstream addenda, both handoffs, [fresh correction-1 review](2026-09-13-prp-472-correction-1-review.md), and both dated security reports. Root user invariants override stale documents: no resident scheduled compose, no empty-permission grants, no skipping staging. No release is authorized.

No PR, provider send, no-mistakes, protected-branch operation, Linear change, commit/push, new database mutation or migration apply is authorized to delegates. Root owns final keeper commit/push only after acceptance. Preserve unrelated fixtures/messages/drafts. Existing exact DEV RPC is applied and independently verified; do not modify its SQL, hash semantics, grants, or apply history. No global person-identity rewrite, new route, polling framework or broad mailbox writer changes.

## Goal

Finish the observed-read contract coherently through repeated opens, overlapping source snapshots and storage failure, while preserving explicit native identity provenance through collapse. Replace incorrect/missing authorization and actual-component test coverage. C1-C4 in the fresh review are mandatory; R1-R5 protections already fixed must remain intact.

## Delegation and file ownership

Sol owns architectural choices, integration, real browser QA, evidence accuracy and final freeze. Terra owns client implementation across `portal-inbox-read-operation.client.ts`, `portal-inbox-storage.ts`, `manager-sms-opened.client.ts`, `unified-inbox-merge.ts`, `pro-unified-inbox.tsx`, `pro-resident-detail-inbox.tsx`, and minimal `pro-sms-panel.tsx` integration if needed. Luna owns tests only: existing read regression tests plus a new retained `ManagerUnifiedInbox` integration test. Have Luna build true boundary fakes rather than copying production decisions. Sol must independently inspect every test and implementation result. Route source changes should be unnecessary unless faithful tests reveal a concrete defect; report any material architecture change to root.

## C1: one coherent confirmed/optimistic source-state contract

Current defect: `reconcileObservedInboxReadRows` changes aggregate unread only, while the next operation takes rollback state from stale GET `readSources[].unread`. A success then failed reopen incorrectly restores unread. A partial success is similarly lost on later operations.

Choose the smallest design that separates confirmed source truth from an operation's speculative overlay and tracks ownership using the existing observation/epoch framework. Do not patch only one example or add unrelated booleans. The state machine must meet all of these:

1. A valid confirmed per-source result advances the corresponding local confirmed unread truth for the exact unchanged observation and recomputes safe aggregate state. The next open uses that confirmed truth. Source metadata updates must not be skipped merely because aggregate unread stays true due to another source.
2. Optimistic clearing is immediate but cannot become another operation's confirmed rollback baseline. An older operation may withdraw only its own compatible optimistic change. Existing viewer authority, exact observation matching and token-owned cleanup remain authoritative.
3. A changed/current GET snapshot wins. Old results must not clear new/revised/unobserved/conflicting/legacy sources. Keep completeness fail-closed through every collapse and preserve body/time/preview/attachments/draft/folder references.
4. Partial results preserve A's confirmed success if B fails. Missing/malformed responses and network-unknown outcomes do not pretend success; retain prior confirmed truth for unknown sources, show bounded recoverable failure, and permit explicit retry. A bounded revalidation is permissible only if needed; no automatic fetch/render loop.
5. Reopen after confirmed read is idempotent in visible state even if its retry fails. Reopen after actual failed first read stays unread until success. Interleaving operations for [A], [A,B], and later [A,B revised] must never restore stale aggregate/source state or erase confirmed partial success.

Behavioral tests must use real reconciliation and controller together, plus actual manager-pane wiring below. Include first success -> close/reopen -> HTTP500; first partial A success/B failure -> later success -> failed reopen; overlapping sets and out-of-order settlement; new GET source/revision while old request pending; already-read and mixed prior truth; malformed/missing/duplicate/extra response records; network reject; and two-source updates when aggregate bool does not change. Verify both aggregate and source truth, not only badge visibility.

## C2: visible failure is a completed attempt requiring explicit retry

Current defect: native setItem throws -> callback always creates a new Set -> controller returns false -> pane does not latch -> callback dependencies change -> repeated writes/toasts/renders, potentially repeated POSTs after settlement.

Define a small shared attempt outcome that distinguishes deferred work (hidden/stale/not rendered) from a visible attempted operation with recoverable failure. Reuse existing ownership and visible-signature concepts. A visible storage failure must not be interpreted as permission to retry on every render.

- Native handling stays independent of email pending work, so newly visible inbound SMS can be opened without a duplicate email POST.
- Deduplicate state publication by actual set membership and avoid replacing a Set with equal contents.
- Bound native storage attempts and failure notification for one visible signature/attempt. A continuously failing getItem/setItem must not cause a render/toast/network loop. Email POST/reconciliation must still proceed and pending ownership must be released.
- Be explicit about in-memory native receipt behavior when persistence is unavailable; do not claim device persistence succeeded. Keep a recoverable error and a fresh attempt on explicit close/reopen after storage recovers. Read exceptions must not silently erase unrelated already-opened IDs if an in-memory confirmed set exists.
- Hidden document AND hidden mobile pane do no receipts or POST. Becoming visible/open triggers one bounded attempt. Visibility deferral must remain retryable, unlike an already attempted visible failure.
- Retained old callbacks, old results, old finally and old toasts cannot act in B or a later A. A later-A epoch can start even while old A is pending.

Add persistent storage failure with a held POST and after success/failure settlement to the actual React integration suite. Assert bounded render/write/toast/request counts, no maximum-update-depth errors, pending release, unchanged unrelated opened IDs and successful explicit reopen after restoring storage. Include native arrival while email pending for both response success and failure; no new provider send or DEV native row is necessary for the deterministic test.

## C3: preserve explicit native binding provenance through the selected snapshot

Current defect: person collapse A/K1 + B/K2 sharing email erases `smsConversationKey`; another same-email native K3 then becomes eligible for merge/display/read even though both actual explicit bindings are unresolved.

Root confirms this is within the feature safety contract. Prefer deriving binding presence/conflict from the selected authorized source snapshot or extending existing response-only observation metadata. Do not add independent flags that can drift from source membership. Conservative unresolved native membership is acceptable; invented identity is not.

- If any selected email source declared an explicit binding, absence/conflict after collapse must never enable email/phone fallback. Preserve owner/role distinctions. Exclude unrelated K3 from display and local acknowledgement even if ordinary unified list grouping would otherwise fold it.
- Exact currently resolved native members may render/open when safe. All locally acknowledged native members must actually be rendered. Keep multiple exact source support and reply/contact context.
- An unbound source set may keep the established unique exact-email fallback; ambiguous multiple matches remain unresolved. No phone/name/body inference.
- Preserve provenance through successive person/assistant/unified collapse, including already-collapsed inputs, missing legacy metadata, conflicting duplicate source observations and mixed bound/unbound rows. No stale `sourceThreadIds` may invent a GET observation or native binding.
- If a transport field is added, populate it only from authorized actual GET records, fail closed on missing/incomplete/conflicting provenance, and strip it at ALL generic durable writers on client and server. Observation hashes and SQL remain unchanged.

Required retained behavioral chain: actual raw A/K1+B/K2 collapse -> unified row -> actual resolver/manager pane with unrelated native K3. Assert K3 does not render/open; include K1/K2 both unresolved, one resolved, both resolved, same-source successive-collapse semantics and mixed legacy inputs. Also preserve two distinct email aliases with one K binding and its native body, root/appended attachments, exact posted observations and winning reply context. Ordinary unbound unique email still works; ambiguous email and shared-phone other owner/role remain excluded.

## C4: prove actual permission semantics

`portal-inbox-read-route-contract.test.ts` currently turns admin role into unrestricted access and ignores actual effective target resolution. Replace this inaccurate permission model. Use actual `applyPortalInboxThreadScope`/filter helper with a filter-aware DB fake, and exercise `resolveInboxScopeUser`'s effective-viewer composition by mocking only its authenticated/effective-context dependencies as necessary. Do not rewrite actual authorization to match the old test.

Required cases:

- Authenticated admin inspecting an authorized effective manager target: target-owned manager sources succeed; unrelated manager-owner sources fail.
- Bare admin status does not independently authorize all manager-scope mailboxes. Mixed authorized/unrelated IDs write zero sources.
- Use real co-manager grant normalization/module access helpers, or their actual composed path, for empty/read/edit fixtures. Empty grants and inbox/read do not confer inbox/edit writes; valid edit grants remain owner-scoped.
- Model `.in`, `.eq`, `.or` and reread filters faithfully. Preserve complete-batch preflight before any mutation and no unauthorized state disclosure.
- Cover CAS false -> authorized reread -> original-observation recheck, changed same-timestamp content, retry bound, reread failure and earlier A success with B retry-read error. Preserve known partial outcomes and never fall back to upsert/folder mutation.

SQL tests/probes already cover service-only privileges and JSON/timestamp CAS. Do not repeat/reapply DEV schema. These route tests establish composition that the SQL evidence alone does not prove.

## Actual-component evidence, validation and browser QA

The correction-1 handoff overstates retained actual wiring coverage: five files/37 tests test pane and controller separately; no retained actual manager+pane+controller suite exists. Correct this in the new handoff, linking exact test filenames/names for every claim. Do not count AST simulations as React or browser tests.

Retain an integration suite that mounts `ManagerUnifiedInbox` with the real `ResidentDirectChatPane`, real controller and real reconciliation/merge helpers. Stub unrelated composer/schedule/transport UI as needed, but do not stub `onViewed` or bypass the selected-source resolver. Drive native arrivals, pane visibility, close/reopen, A-B-A authority and controlled network settlement through observable UI or faithful source events. This suite must catch C1-C3 before fixes and pass afterward. Assert actual email/SMS bodies, attachment associations, exact posted source IDs and native opened IDs, no selection jump/loop under Read/Unread filters, and no stale-viewer toast/state.

Run focused regression/compatibility checks and affected lint/typecheck first. Retain PRP-470 initial-readiness, viewer-generation, success-only TTL, application readiness, SMS coalescing/polling and upstream status/archive/composer tests. Root owns one serial full unit/lint/build run after the final source freeze on the 8GB host; do not duplicate broad runners. Report exact commands, counts and exit codes, and do not treat a passing broad run as missing-case coverage. Run the graph hook once if source changed, preserving honest existing tooling-failure attribution without global repair.

Coordinate the existing pinned port 3009 browser/server with root. Root stopped it for serial broad validation. Launch only after pinning, with exact app guards `SMS_COMM_UI_ENABLED=true SMS_RUNTIME_ENABLED=0 SMS_OUTBOX_SCHEDULER_READY=0 SMS_PROVISIONING_ENABLED=0`, verified DEV target. Preserve canonical fixture `prp472-dev-merged-read` and native `23cd9472-4720-4472-8472-000000000001`, plus unrelated inbox state. No provider sends. Any new bounded fixture mutation must be coordinated with root, attributable, and exactly cleaned.

Drive real desktop and 390px primary open/reload, success then failed reopen before refresh, forced failure -> explicit reopen recovery, persistent native storage exception with bounded behavior/recovery, and hidden-document/mobile-pane gating. Reuse existing exact-binding/alias evidence where unchanged, but recheck impacted alias/source mapping if provenance changes. Test novel identity variants hermetically unless root authorizes a bounded fixture addition. Screenshots must be final-source and honestly distinguish browser evidence from deterministic component cases. No release/full E2E promotion is authorized.

Deliver `docs/plans/2026-09-13-prp-472-correction-2-handoff.md` with C1-C4 resolution map, final data/state decisions, source/test files, exact validation, final browser artifact paths/runtime, fixture cleanup, remaining limitations and SOURCE FREEZE. Then fresh Astra/security/Bugbot review. If actionable findings remain after that review, report them to Akhil; do not silently start a third automated correction or waive them to finish the backlog.
