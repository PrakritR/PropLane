# PRP-470 final independent Astra review

Date: 2026-09-13. **Keeper verdict: PASS for the reviewed PRP-470 change and normal keeper handoff.** No remaining actionable finding was established in the final diff. The second correction resolves B2, and the earlier SMS authorization/contact corrections remain intact. This verdict is not release authorization or full portal E2E/staging certification.

## Exact reviewed identity

- Worktree: `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/6/AXIS-2`.
- Branch: `akhil/prp-470-inbox-loading`.
- Base and current HEAD: `7b3d464fe2f102a527949044fc0289513d50029f`, independently verified. The candidate is uncommitted.
- SHA-256 of `git diff --binary HEAD -- src tests`: `57361e92110827af71913df948d36345489b7ce76923d6cd031240bf6ff52d8d`.
- SHA-256 of the complete tracked `git diff --binary HEAD`: `cc2ba6a4aa01ca8e25ac34cf20fbae6cc13d78b40e260905d6b89fc6bcc83d72`.
- New `src/components/portal/communication-inbox-initial-state.tsx`: `eea7d384a39695e42e9ffd8648ae231e8290fa4808d42c94ca88012bb22c6a03`.
- New `tests/unit/inbox-initial-loading-readiness.test.tsx`: `1094d08a91e66631803cb30d8b91813bee484f80ea8c5b3886cf01b969b318ee`.
- Updated `docs/agents/communication-inbox.md`: `e87eee8e065798ad2864982ae031342126c5c02a4b542b866173eaf5b326f846`.

Reviewed all eight tracked source/test changes, both added source/test files, the Communication invariant, original plan/handoff, both correction plans/handoffs, previous Astra/security/Bugbot findings, and root's final validation artifact. Read repository/Akhil/ship-gate/Communication instructions, root feature-cycle instructions, UI/parity guidance and installed Next client-fetching/loading guides. The pool checkout has no graph; the previously attempted graph rebuild still has the documented missing-executable limitation. No graph result was represented as current evidence.

## Findings and resolution

Critical: none. High: none. Medium: none remaining in the reviewed correction scope. No new actionable Low finding established.

**B2 / P2: resolved.** `src/components/portal/pro-unified-inbox.tsx:768` now retains the status-aware result. Its entry check at line 778 rejects a callback whose rendered viewer authority no longer matches. The authority changes across committed A to B to A transitions, so repeated viewer strings do not restore the first callback's authority. A monotonically increasing direct-refresh generation also rejects superseded completions. At line 797, current authority, latest request, `ok` and `stale` are checked before `setEmailThreads`, selected key, mobile-open state, parent route callback or URL replacement. Failure/rejection returns without those publications. The forced path at line 785 uses a per-authority coalescer, with one active read plus one shared trailing read for overlapping forced calls.

The six permanent direct-send cases at `tests/unit/inbox-initial-loading-readiness.test.tsx:786`, `:834`, `:871`, `:889`, `:910` and `:937` exercise the real component callback with a provider-free pane and the correct status-loader `(key, options)` signature. They cover pending A then B-ready, pending A-B-A, failure preservation, successful placeholder-to-thread selection, three callbacks bounded to two serial reads, and retained A callback invocation after B takes over. The status loader's actual stale-empty behavior is independently covered at lines 58, 83 and 103. These tests address the failure reproduced in correction-1 review.

**SEC-470-1/B1 and SEC-470-2: remain resolved.** Manager layout reset at `pro-unified-inbox.tsx:255` clears prior-viewer SMS contacts and the auth latch. The loader at line 329 checks viewer/epoch before 401/403 side effects and after JSON, and its functional row update checks ownership. Permanent late-401/403, auth-reset and accepted/optimistic-contact tests remain at readiness-test lines 478, 524 and 558. Retry retains its fixed analytics attribute and promise-returning Button handler in `communication-inbox-initial-state.tsx:23`.

The separate final affected reviews are retained under `docs/security/2026-09-13-prp-470-final-security.md` and `docs/security/2026-09-13-prp-470-final-bugbot.md`. Both assess the same final source snapshot and establish no new actionable finding.

## Publication and acceptance review

| Path | Reviewed result |
| --- | --- |
| Manager initial membership | `pro-unified-inbox.tsx:387` joins inbox, applications and enabled SMS; current request generation and stale results gate acceptance. Parent directory refresh is stable in `pro-communication.tsx:117` and runs with ready publication. |
| Resident initial membership | `resident-communication.tsx:194` joins inbox and enabled SMS; current generation guards acceptance. Optional manager contact metadata does not delay membership. |
| Storage | Inbox captured viewer cache key/generation guards auth effects, JSON publication and finally ownership (`portal-inbox-storage.ts:295`). Applications retain scope-generation checks and separately track successful reads (`manager-applications-storage.ts:758`). Both preserve legacy array exports. Local staging is not initial server success. |
| SMS refreshes | Manager poll, visibility, contact refresh and direct-send SMS share the guarded loader. Resident SMS checks epoch/request generation before replacing rows. Background failure does not reset a usable list to the initial skeleton. |
| Direct-send email | Status, rendered authority and latest-request checks protect all component and route publications together. Same-viewer successful sends still resolve directory placeholders. |
| Cache/events/assistant staging | Existing synchronous cache reads and assistant staging remain; provisional rows are hidden by initial readiness. These unchanged paths are not newly certified as a general asynchronous write-isolation framework. |
| Bulk and child callbacks | Bulk archive/restore/delete publish after their separate mutation results, not through the changed status reader. Their existing async write behavior is unchanged. Row-open/controlled-id callbacks remain synchronous; the affected `ResidentDirectChatPane.onSent` continuation is the corrected callback above. |

The skeleton hides initial rows, counts, empty/add controls and selection until readiness. It supplies one status label and `aria-busy`, uses existing tokens and disables pulse under reduced motion. Successful empty responses reach existing empty states; malformed/failing top-level payloads reach Retry. Existing pending deep links remain available until the complete list resolves them. No route, schema, RLS, attachment, provider send, native registry, server cache or heavyweight dependency change was introduced. Capacitor uses the same portal UI; recorded mobile-browser evidence is not a native simulator test.

## Verification and attribution

This reviewer independently inspected the final source/tests, screenshot artifacts and recorded DOM snapshot, checked hashes/HEAD/branch, read the complete local unit/build result summaries and ran `git diff --check` (exit 0). Broad tests were not redundantly rerun. Execution evidence is attributed to the executor/root, not to this reviewer's own test run.

- Root full unit: explicit Node `v22.23.0`, `node_modules/vitest/vitest.mjs run tests/unit`, exit 0; **1,423 files / 10,031 tests**, 264.98 seconds. Log: `/private/tmp/axis-inbox-cycle/prp470-c2-full-unit.log`.
- Timing caveat is preserved: Sol removed one tautological comparison and corrected its comment after the full suite began. Final-source readiness (26 tests), impacted lint and TypeScript passed after that nonbehavioral cleanup. The broad suite is not claimed to have run against an immutable snapshot.
- Executor focused regression matrix: 12 files / 76 tests, exit 0. Final impacted quiet ESLint and 8 GB TypeScript check: exit 0. Previous full lint: exit 0 with 725 existing warnings; final affected lint checks cover the correction.
- Root final-source build: verified Node22 PATH, shell login disabled, `NODE_OPTIONS=--max-old-space-size=8192 npm run build`, exit 0. Log independently confirms compilation in 6.4 seconds, TypeScript in 6.2 seconds and **394/394 static pages**. Log: `/private/tmp/axis-inbox-cycle/prp470-c2-build.log`.
- Executor preflight: exit 0, 11 checks with documented local environment/dirty-tree warnings. No promotion followed.
- Graph hook: exit 1, `could not determine executable to run`; no graph exists in this pool checkout. No global tool repair or other worktree mutation was attempted.

Root's durable final evidence is `docs/plans/2026-09-13-prp-470-root-validation.md`; it closes the pending full-unit/build items in correction-2 handoff.

Browser evidence remains attributable to root/executor and previous fresh review. It used real dev/test fixtures (`emstjswhotsnyksqhqyf`), including six PRP-470 threads and Morgan's directory-only application. Recorded manager and resident deferred membership, 503/Retry recovery, warm return, mobile list-first behavior and message/contact deep links were reviewed. Both manager source-completion orders additionally have behavioral unit coverage. This reviewer visually inspected the actual loading, loaded and error screenshots under `output/playwright/prp470/`, and the mobile loading DOM snapshot `.playwright-cli/page-2026-09-13T19-54-53-012Z.yml`. The prior fresh review independently observed zero rows becoming nine and mobile 503 recovery. Correction-2 executor observed Morgan's correct encoded contact URL and one empty reply composer without editing a draft or sending a message. No new live send was necessary to test the corrected callback; the permanent regressions invoke it without a provider.

Root restored the pinned port 3009 server after final build, SMS UI enabled and managed SMS runtime/scheduler disabled. This reviewer independently rechecked the Review URL and received HTTP 307 to sign-in, confirming reachability. Review URL: `http://localhost:3009/portal/communication/active`.

## Limits and handoff

The direct-send tests assert parent route callbacks while mocking the browser URL helper; they do not independently assert its calls. Retained-callback entry after B and old completion after A-B-A are separate cases rather than one retained-entry A-B-A case. Source inspection verifies that the same authority check and acceptance block cover these combinations. These are coverage boundaries, not established regressions.

The existing optional optimistic contact event lacks originating-viewer metadata, but current production producers supply no optimistic payload. Unchanged asynchronous bulk-write/child-panel flows and same-identity session renewal are outside this bounded correction's certification. A queued old-authority coalescer may still finish a read after a switch, using the storage loader's current authenticated scope; its obsolete component continuation is rejected. No stale contact/route publication was established from that queue.

The pre-existing narrow mobile composer remains the documented baseline limitation. Full portal E2E and staging QA remain prerequisites for a later authorized release. The keeper may proceed to the normal handoff; no third automated correction cycle is needed. This reviewer wrote only this review artifact, and its delegates wrote only their separate reports. No source/test edits, probe, commit, push, PR, Linear change, database write, production action, or no-mistakes invocation occurred in this review.
