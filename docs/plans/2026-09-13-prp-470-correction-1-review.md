# PRP-470 correction cycle 1 independent Astra review

Date: 2026-09-13. **Keeper verdict: changes required; execute correction cycle 2 before commit/push handoff.** No release or promotion approval.

## Exact reviewed identity

Worktree: `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/6/AXIS-2`. Branch: `akhil/prp-470-inbox-loading`. Base and current HEAD independently verified: `7b3d464fe2f102a527949044fc0289513d50029f`.

Reviewed the complete uncommitted source/test diff, not only the correction: manager Communication/unified inbox, resident Communication, inbox and applications storage, three existing test files, plus the new initial-state component and readiness test. Also read both plans/handoffs, previous review and security/Bugbot reports, repo/Akhil/feature-cycle contracts, Communication/UI/parity documents, and installed Next client-fetching/loading guides.

Exact SHA-256 identity:

- `git diff --binary HEAD -- src tests`: `e915cb741c44458ea94005295e4047dc9828f9ae2ee32b302d64a99b1c1b8ff4`.
- New `communication-inbox-initial-state.tsx`: `eea7d384a39695e42e9ffd8648ae231e8290fa4808d42c94ca88012bb22c6a03`.
- New `inbox-initial-loading-readiness.test.tsx`: `d796289c8c1f2bae92c76397ed9bf02a248c939bc6c27726e2043f6727c464c9`.
- Updated `docs/agents/communication-inbox.md`: `e87eee8e065798ad2864982ae031342126c5c02a4b542b866173eaf5b326f846`.

No graph exists in this pool checkout. Area documents and source supplied evidence. The executor's graph hook still exits 1 because npm cannot determine the executable; this is an environment/tooling limitation, not permission to change global tools or other worktrees.

## Finding

**P2 / Medium - a stale direct-send email refresh erases the new viewer's ready list.** `src/components/portal/pro-unified-inbox.tsx:758-759` calls the legacy array loader and publishes its result without current-viewer/generation or success checks. `src/lib/portal-inbox-storage.ts:347-351` strips the status from the new result; obsolete requests deliberately return empty rows at lines 313/317. The storage cache remains correctly isolated, but the component accepts that empty fallback as B's display data.

Concrete sequence: A opens a directory-only contact; its authorized send callback starts an inbox refresh; the mounted component switches to B and completes B's initial list; A's old refresh settles as stale. Its callback writes `[]` over B's accepted email rows while B remains marked ready. The list can disappear until a later store event/refetch. The callback also contains selection and URL publication which must share the same validity guard. The SMS half now uses the guarded loader; the email half still needs correction.

Bugbot independently reproduced this using the real direct-pane callback and a mocked legacy result matching the storage's established stale shape. The temporary test passed the intermediate assertion that B's accepted row was visible, then failed after resolving A's refresh with `[]`: expected B's row to remain, received null. Explicit Node22 Vitest command exited 1 (one failed, 20 skipped). Root authorized this bounded probe; the temporary file was removed and existing source/tests were not changed. See `docs/security/2026-09-13-prp-470-correction-1-bugbot.md` for exact command and evidence.

Required correction: preserve the status-aware result, guard initiating viewer/generation and every publication, retain usable rows on failure, and test stale completion plus same-viewer success. Concrete last-cycle plan: `docs/plans/2026-09-13-prp-470-correction-2.md`.

## Previous findings

All four earlier findings are resolved in the recorded snapshot. Manager SMS checks identity/epoch before status side effects and resets the auth latch on viewer transitions; layout-phase reset removes accepted and optimistic prior-viewer contacts. Permanent tests cover late A401/403, already-halted A to B, and accepted contacts across A-B-A. Retry now has the fixed analytics attribute and promise handler. Historical runtime attribution has been corrected; subsequent checks explicitly identify Node22. These resolutions do not cover the newly reproduced email callback above.

The separate fresh security report, `docs/security/2026-09-13-prp-470-correction-1-security.md`, passes the bounded security correction and closes SEC-470-1/2. It documents a hypothetical future producer limitation for optional optimistic event metadata; no currently reachable new disclosure was established. Bugbot closes its original B1 but requests changes for the new B2.

## Acceptance and validation evidence

Source and behavioral test inspection support initial manager aggregation of inbox, applications/directory and enabled SMS; resident aggregation of inbox and enabled SMS; disabled-SMS no-request behavior; successful empty distinct from malformed/failure; deferred deep-link/selection resolution; and retained ready lists after background SMS failure. The shared skeleton is noninteractive, has a single status label and aria-busy, follows existing tokens and reduced-motion behavior, and hides provisional counts. No new heavy dependency, server/RSC boundary, route, schema, provider send, attachment or native registry was introduced. The same portal component renders in Capacitor; mobile-browser evidence is not a simulator test.

Independently inspected the expanded 20-case readiness suite and final source. Bugbot reran the existing readiness, SMS polling, manager conversation and resident conversation tests with explicit Node22: exit 0, four files / 35 tests. Its additional failing probe establishes a missing path despite those green tests. This reviewer ran `git diff --check` with exit 0. Broad suites were not redundantly rerun during review.

Correction handoff/root evidence records explicit Node22 readiness 20 tests, focused 12 files / 69 tests, full unit 1,423 files / 10,025 tests, all exit 0. The earlier focused count of 70 was a reporting mistake corrected to the actual 69. Full lint exited 0 with 725 existing warnings; final impacted quiet lint after unused-helper cleanup exited 0. Typecheck with 8 GB heap, build (394 static pages), preflight and diff check exited 0. The report clearly separates historical Node23 worker evidence from correction checks. These are executor/root results, not a claim that this reviewer reran the broad commands. Preflight warnings and graph limitation remain documented in the handoff.

Fresh browser check used Playwright skill/session `inbox-cycle` against the existing dev/test manager fixture. The first fresh navigation failed with `ERR_CONNECTION_REFUSED`; root restored and owns the pinned 3009 server with verified Node22, SMS UI enabled, runtime/scheduler disabled. A subsequent real navigation succeeded and initially showed `Loading conversations…` without list rows or provisional counts (`.playwright-cli/page-2026-09-13T19-54-53-012Z.yml`), then nine rows including `Morgan No Message`. At the retained mobile viewport, the base route had zero textareas. A scoped 503 interception of initial inbox GETs displayed the Retry control; removing interception and clicking Retry restored the real directory fixture and nine rows. Final DOM evaluation independently returned `{ rows: 9, retry: 0, composer: 0 }` at `/portal/communication/active`. Interceptions were removed. No draft was edited or provider message sent.

The executor additionally records resident enabled-SMS delay to six rows, directory deep links, mobile contact deep link and Retry analytics. Those unchanged paths were inspected as evidence without broad repetition. The previously attributed cramped mobile composer remains an unchanged baseline limitation. Full portal E2E and staging QA remain prerequisites for a future release; no ship request or promotion is part of this review.

Review URL is reachable: `http://localhost:3009/portal/communication/active`. It is available for inspection, but the reproduced P2 blocks keeper completion. Only review/plan artifacts were written by this reviewer. No source fix, commit, push, tracker change, database operation, production action, or no-mistakes invocation occurred.
