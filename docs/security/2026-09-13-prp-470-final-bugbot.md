# PRP-470 final Bugbot affected re-audit

Date: 2026-09-13. Independent bounded source/test review of correction cycle 2. This reviewer wrote only this report. No tests, temporary probes, browser sessions, database/provider actions, code fixes, commits, pushes, or release actions were performed.

## Exact candidate

- Worktree: `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/6/AXIS-2`.
- Branch: `akhil/prp-470-inbox-loading`.
- Base and current HEAD: `7b3d464fe2f102a527949044fc0289513d50029f`.
- Candidate: complete uncommitted source/test diff against that HEAD.
- SHA-256 of `git diff --binary 7b3d464fe2f102a527949044fc0289513d50029f -- src tests`: `57361e92110827af71913df948d36345489b7ce76923d6cd031240bf6ff52d8d`.

Untracked additions, reviewed in full and hashed separately:

- `src/components/portal/communication-inbox-initial-state.tsx`: `eea7d384a39695e42e9ffd8648ae231e8290fa4808d42c94ca88012bb22c6a03`.
- `tests/unit/inbox-initial-loading-readiness.test.tsx`: `1094d08a91e66631803cb30d8b91813bee484f80ea8c5b3886cf01b969b318ee`.

All eight tracked source/test changes were inspected: `pro-communication.tsx`, `pro-unified-inbox.tsx`, `resident-communication.tsx`, `manager-applications-storage.ts`, `portal-inbox-storage.ts`, and the resident-conversation, unified-conversation, and unified-inbox-sms-poll unit suites. Root AGENTS, Akhil instructions, Communication contract, both prior Bugbot reports, and correction-2 plan/handoff were read. No `.graphify/graph.json` exists in this checkout; the area contract and source were used.

## Findings and disposition

No new actionable Critical, High, Medium, or Low regression was established in the affected correction scope. Prior B1 and B2 are resolved in this snapshot. This is a clean bounded source-review verdict, not a certification of every pre-existing asynchronous write in Communication or release authorization.

### B1, previously Medium/P2: resolved

At `src/components/portal/pro-unified-inbox.tsx:339`, SMS checks captured viewer id, epoch, and optional initial-load generation before interpreting an authorization response. At line 354 it repeats generation checks after body parsing, and the state updater checks its owning epoch at line 362. The layout effect at line 255 resets contact rows and the authorization latch on viewer transitions. A late A401/A403 therefore cannot halt B's retry or publication. Same-viewer authorization refusals still halt polling; retryable failures retain accepted rows.

Permanent readiness tests include both old-viewer refusal statuses, a legitimate A halt followed by B login, successful stale SMS responses, same-viewer optimistic contact retention, and contact removal across A-B-A. Resident enabled-SMS failure/retry and stale response coverage is also retained.

### B2, previously Medium/P2: resolved

`src/components/portal/pro-unified-inbox.tsx:768` now uses the status-aware loader through a scoped refresher. The prior legacy-array continuation that converted stale status into unconditional empty-row publication is gone.

- **Entry ownership:** the callback closes over `viewerAuthority`, allocated for the rendered viewer at line 241. It compares that object and viewer id with committed current refs at lines 771-778 before starting either email or SMS work. A callback retained from A cannot begin a refresh after B takes over, and the original A authority is distinct from the new A authority following A-B-A.
- **Completion ownership:** each accepted direct-send invocation increments `directSendRefreshGeneration`. The continuation at line 797 requires current authority, latest request generation, successful status, and absence of `stale` before any publication.
- **One publication boundary:** rows at line 799, contact-to-thread selection at line 809, parent route notification at line 811, and browser URL update at line 812 all follow that guard without an intervening asynchronous boundary. Failed/stale results and rejected promises retain existing rows and selection. A successful same-viewer result still resolves a placeholder contact by normalized email and opens the resulting thread.
- **Repeated calls:** refreshers are stored per viewer authority at lines 784-789 and the map is cleared during viewer transition. `createCoalescedRefresher.run(true)` starts one read immediately, then joins concurrent forced callers to one trailing read. For three callbacks arriving while the first read is pending, the email path starts exactly two non-overlapping reads. The latest direct-send generation is the only continuation allowed to apply contact/route context from the shared result. This count concerns the forced email reads; enabled SMS refreshes are separate.

## Publication-path inventory

| Path | Review disposition |
| --- | --- |
| Manager initial inbox/applications | Lines 389-417 retain nonforced storage joining and successful-source readiness; obsolete generations and stale results return before rows or parent directory refresh. The stable parent callback in `pro-communication.tsx` updates the directory with readiness. |
| Inbox storage | `portal-inbox-storage.ts:286` distinguishes successful empty responses from failures; captures viewer cache key and monotonic cache generation; rejects old responses before auth/cache side effects and after JSON parsing; clears only its own in-flight promise. Local staging no longer creates server-success freshness. Legacy array exports remain available. |
| Applications storage | `manager-applications-storage.ts:758` preserves existing merge behavior while making actual server success, failure, and stale generation explicit. Initial readiness no longer treats a local write timestamp as successful server synchronization. |
| Manager SMS/poll/contact/direct send | The common guarded loader owns accepted response publication and authorization-stop effects. The corrected direct-send entry also blocks an obsolete callback before starting SMS. The optional optimistic contact-event payload remains without origin identity, as documented in earlier review; this correction does not redesign that existing event contract. |
| Resident initial email/SMS | `resident-communication.tsx:173` and its initial loader retain request/epoch checks, status-based readiness, and gated row/selection rendering. Source failures do not reveal provisional membership. |
| Cache/store listeners and assistant staging | List cache listeners synchronously read the viewer-scoped cache. Existing assistant staging and its queued microtask are unchanged by correction 2; initial membership remains hidden behind readiness. These paths do not consume the corrected direct-send read result. |
| Bulk archive/restore/delete | `use-unified-communication-bulk.ts` publishes mutation results after success and clears selection. These unchanged asynchronous writes do not consume the changed status read API. Their broader account-switch behavior is not certified by this bounded read-path fix. |
| Child callbacks | Synchronous row selection remains unchanged. The direct pane's asynchronous `onSent` continuation now has the boundary described above. Existing child archive/delete completions remain separate write flows. |

## Evidence and limits

The permanent direct-send suite at `tests/unit/inbox-initial-loading-readiness.test.tsx:705` mounts the real manager component and its real `onSent` callback behind a mocked pane. Its loader adapter correctly accepts `(storageKey, options)` before forwarding options. The six cases cover pending A/B-ready stale completion, A-B-A completion, same-viewer failure, same-viewer placeholder success, exactly two coalesced forced reads, and delayed invocation of a retained callback after B takes over.

Coverage limits are narrower than the test titles might imply: the route assertions observe `onRouteThreadChange`; the actual browser URL helper is mocked without assertions. The A-B-A completion supplies an explicitly stale result, so it does not independently prove the authority guard against an `ok: true` obsolete result. The source guard establishes both cases in this snapshot. The same-viewer failure test directly checks selected placeholder retention but does not separately assert the other pre-existing row. These are coverage limitations, not reproduced implementation failures.

The correction-2 handoff reports exit 0 for 26 readiness cases, 76 focused cases across 12 files, focused lint, TypeScript, diff check, and ship preflight. Those results were read, not rerun by this reviewer. Final broad-unit/build results, browser QA, and any release gates remain owned by root; no claim about their completion is made here.
