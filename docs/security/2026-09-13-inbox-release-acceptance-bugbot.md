# Inbox release acceptance Bugbot review

Date: 2026-09-13. Verdict: **PASS FOR REVIEWED SOURCE. FINAL RELEASE VALIDATION PENDING.**

This fresh Astra subagent performed the delegated mandatory branch-change Bugbot review and retains it separately from the root-coordinated independent security review. No external hosted Bugbot service or script execution is claimed.

Reviewed keeper `akhil/prp-472-inbox-unread`, HEAD `276e1e40a0a9f3f63bee3a87b4fabbbd9edaf54b` plus the frozen 33-path working source/test/SQL/probe delta, against base `75d711053085e340072c605bcb96eaa9416ef87e`. Aggregate `7432b0cc36d65cd4822aa16295e368812194258ad4b4d7fe35b64f11df263ce8`. Independently rehashed all 33 paths: zero mismatches, exit 0.

## Findings

**No new actionable bug found. No unresolved Critical/High finding in this reviewed scope.**

- Previous P2 R1 is resolved: the visible initial Retry explicitly resets the SMS authorization halt and returns the initial loader promise. Automatic retries remain halted; stale viewers cannot publish. Retained mounted tests cover 401 and 403 recovery and repeated refusal before a later explicit success.
- Previous P2 R2 is resolved: migration and rollback probe require an empty trigger column vector. Executable PGlite coverage rejects the narrowed actual-function UPDATE OF trigger and verifies transaction rollback, while retaining exact fresh/double-install and lifecycle checks.
- Earlier failed-envelope unread race remains corrected: unknown results withdraw only their own compatible overlay; successful siblings and newer confirmed state survive both settlement orders. Actual controller/reconciler tests cover the race instead of testing callbacks alone.
- Earlier mounted native receipt persistence failure remains corrected: explicit reopen checks durable storage despite volatile membership, preserves unrelated receipts, and hidden controlled opens defer once. No automatic render retry or provider send is added.

Reviewed the complete frozen change scope for initial readiness, same-viewer retry, viewer epochs, forced-refresh coalescing, legacy loader compatibility, merged source/binding provenance, exact displayed history, authenticated route/edit ownership, compare-and-set behavior, partial outcomes, native receipts, and additive recovery wiring. Detailed contract assessment is in `docs/plans/2026-09-13-inbox-release-acceptance-review.md`.

## Evidence and remaining gates

Final Sol handoff reports the serialized Node 22 inbox matrix (9 files/88 tests), recovery matrix (3 files/41 tests), and focused lint all exit 0. Reviewer inspected retained behavioral assertions and exact source hashes; no heavy suite was rerun. Earlier real DEV mixed-thread and mounted receipt QA pertains to unchanged source bytes. Graph lookup/refresh remains unavailable locally and is not represented as passed.

Root's exact-freeze full unit passed 1,465 files and 10,349 tests, exit 0 (217.73 seconds); full lint exited 0 with 746 existing warnings (91.34 seconds); build exited 0 with the DEV assertion (60.34 seconds). Actual same-viewer DEV 401/403 Retry QA passed repeated refusal, explicit recovery, refocus refusal, and mobile fit. Reviewer read `/private/tmp/axis-inbox-release/dev-retry-browser-result.json`; both status cases reveal the list after recovery with no mobile overflow and one additional SMS request per explicit retry. Root retains screenshots. No broad check was rerun by this reviewer.

Root relayed a completed corrected-source actual staging rollback rehearsal: exit 0, all seven fixture-leak counts zero, full pre/post catalog equality, and double-install assertions retained. Migration hash `0848ed305b3fa742f1b16e75133931718c7c05b10f7b4df760d7ded2467d53a4`, private wrapper prefix `bbbcf475`. Root checkpoint `542d11ca0` preserves every reviewed frozen hash. This Bugbot pass permits continued root validation; it is not a completed release or additional production authorization. Production prerequisites remain separately reviewed in `2026-09-13-prp472-production-prerequisites-review.md`.

## Focused E2E harness addendum

**Accepted, no actionable finding:** `tests/e2e/mobile-portal-layout.spec.ts:106` now retries only the resident document measurement across context destruction during a normal stage redirect, bounded to 10 seconds. The overflow collection and final assertion remain outside the retry. An actual `true` overflow result completes the measurement and still fails the final assertion; this change cannot retry a failing overflow away. No application, authorization, route, SQL, or native behavior changes.

Reviewer rechecked all original 33 hashes: unchanged. Additional harness SHA-256 `d9bf6975fad0404c0ba88954c8de6efe7b316d1ba63831602ca75b69813c036e`; expanded 34-path freeze capture is root-owned. First retained E2E attempt passed 10/12 after private stale-account settings were corrected. Root resolved the missing test email fixture with one exact insert-only DEV row and applied the reviewed measurement fix; the full 12-case rerun and scoped harness lint/typecheck are pending. Earlier failures are not represented as a passing run. Final deployed staging QA, preflight, and release verification remain subsequent root-owned gates.

Only review artifacts were written. No source/Git/database/browser/server/provider mutation and no no-mistakes. Re-review affected changes if the freeze changes.

## Composer maintenance addendum

The new composer test delta is accepted after comparison against the frozen shared UI. Its optional fixture label preserves exact direct-pane textarea/form scoping; actual focus, click, filechooser, empty/draft Send, desktop emoji, phone emoji hiding, and current schedule configure/cancel assertions remain. Phone attachment geometry follows the existing 36px control. No send or upload occurs. The already-reviewed resident navigation measurement retry remains sound.

Composer test SHA-256: `cb394180c74ef0cd975cabe37fab7ef69312c49ff341772732e8ae19192317f3`. Original 33 hashes were independently rechecked unchanged; expanded 35-path capture is root-owned. Sol reports scoped composer lint/diff checks exit 0. See the maintenance plan/handoff under `docs/plans/2026-09-13-inbox-composer-qa-maintenance-*`.

**New runtime validation finding, release QA unresolved:** root's E2E rerun reached the preserved `>140px` textarea assertion and measured 129px at 375px. This is a real geometry assertion failure; the maintenance is not grounds to call the run passing or relax the threshold. Disabling SMS does not, by source inspection, remove the direct pane's always-rendered Send via menu, so default-flag QA cannot be assumed to resolve the same width. A different generic inbox pane cannot substitute for this direct-pane test. Root owns resolution and final E2E evidence; no product correction or passing rerun is claimed here.
