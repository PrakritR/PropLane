# PRP-473 resumed reply-fix execution handoff

Date: 2026-09-10

Plan: `docs/plans/2026-09-10-prp-473-resumed-reply-fixes.md`

Worktree: `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/3/AXIS-2`

Keeper: `akhil/backlog-repeat-issues`
Starting/current commit: `0b6d56794407277761ad5f6c680a522e97db2e6d`

This resumed execution fixes the two Medium reply defects from review 3 while preserving the complete dirty PRP-473 implementation. Nothing was committed, pushed, merged, promoted, deployed, ticketed, or sent to a real provider. No production data was accessed or written. SMS runtime and scheduler remained disabled.

## Integrated source decisions

- `src/lib/tour-reschedule-sms-reply.server.ts` now builds one scoped actionable inventory across planned and pending records before choosing any reply target. The shared predicate covers owner, exact guest/work-number pair, active or pending state, window, proposal status/version/generation, row generation, and modern/legacy eligibility shape.
- Every legacy candidate is re-authorized with the existing `resolveTourSmsEligibility`. Only the narrow definitive denials `recipient_opted_out`, `tour_sms_revoked`, `tour_sms_consent_missing`, and `scoped_consent_missing` exclude a candidate. Arbitrary resolver errors, exceptions, and a resolved/stored conversation-key mismatch are unresolved and prevent confirmation through the existing ambiguity/follow-up path.
- Legacy candidates are resolved sequentially so a shared scoped grant is not materialized concurrently for an inventory. No bulk repair occurs. An eligible legacy row is upgraded only when it is the sole safe candidate.
- The original `LegacyRepairGuard` now reaches both pending and planned final CAS callbacks. `upgradedLegacySnapshotMatches` runs on every CAS retry, covering record/event/source identity, owner, phone pair, window, row/proposal generation, version/status, conversation identity, request timestamp, SMS origin, and stored consent.
- The guard also binds `recordId` and event id to the selected final candidate. A repaired planned row cannot retarget the reply to a same-id pending row, or vice versa.
- Planned alternate-time replies still notify the manager first and terminally mark the proposal only after the notice succeeds. Pending alternate-time replies preserve their prior non-terminal manager-follow-up contract. A rejected CAS never reports confirmation and never spends the inbound SID.

Final source SHA-256: `a75cd1caf2d02bf6a4da3ba61353240fd0f765b63d64bf5e14d9ebcc9a1ecbe5`. Final focused test SHA-256: `6d910219dc8ef3007f90f4924c7f80ac7a4e0aa1e7ea633e1cf3246acca54ad1`.

## Delegate and red-first evidence

- Fresh GPT-5.6 Luna owned `tests/unit/tour-reschedule-sms-reply.test.ts`. Baseline was exit 0, 29/29. After adding the planned/pending final-CAS field races, planned alternate-time race, mixed ambiguity, and unreadable-authority cases, the file exited 1 with 13 failures and 29 passes. This was captured before Terra touched source.
- Fresh GPT-5.6 Terra owned only `src/lib/tour-reschedule-sms-reply.server.ts`. Its initial integrated source passed 42/42. Exact conversation-key enforcement then deliberately exposed two unrealistic legacy fixtures; Luna updated positive fixtures to canonical keys and retained a separate mismatch fail-closed regression.
- Luna resumed and expanded the complete matrix. Sol inspected the source and tests, changed key mismatch from unsafe exclusion to unresolved, bound guard record identity, made legacy authorization sequential, and strengthened two test classes that could otherwise pass for the wrong reason.
- Final adversarial tests assert the contested read occurred, advance the fake database CAS token, retain the exact competitor, and show only the eligibility-upgrade write succeeded. Failed final-CAS retries mutate exactly one formerly omitted field while retaining current id/version/generation/status/eligibility. The cross-record race activates the same-id competitor only after repair and makes the original row inactive.
- Root independently replayed the retained no-file bugbot harness against the final source, exit 0. All five post-guard final-read mutations returned stale with one repair write, no SID, and the competitor field preserved; two legacy plus one modern returned ambiguous with zero writes and all proposals awaiting. This is attributed root evidence, not a Sol-run command.

## Final validation

All behavioral checks used Node 22.23.0, `NODE_OPTIONS=--max-old-space-size=4096`, `SMS_RUNTIME_ENABLED=0`, and `SMS_OUTBOX_SCHEDULER_READY=0`.

| Command | Result |
| --- | --- |
| `npx vitest run tests/unit/tour-reschedule-sms-reply.test.ts --maxWorkers=1` | Exit 0, 1 file / 54 tests after final fixture strengthening |
| Ten-file PRP-473 affected unit command from review 3 | Exit 0, 10 files / 189 tests |
| `npx vitest run tests/integration/webhooks/twilio-sms.test.ts tests/integration/public/property-lead-message.test.ts --maxWorkers=1` | Exit 0, 2 files / 11 tests |
| `npm run test:unit -- --maxWorkers=2` | Exit 0, 1,367 files / 9,483 tests, 329.27 seconds |
| `npx tsc --noEmit --pretty false --incremental false` | Exit 0 after final test strengthening |
| `npm run lint` | Exit 0, 0 errors / 726 existing warnings |
| `npm run build` | Exit 0, Next 16.3.4 compiled, TypeScript passed, 385/385 pages generated |
| `git diff --check` | Exit 0 |
| `npm run ship:preflight` | Exit 1: remote `origin/staging` absent; dirty keeper and shell-local production variables also reported. No promotion attempted. |

The full unit run used the final source and the 54-test matrix before one final test-only strengthening: the retry fixture was changed to clone the already-upgraded row at the contested read instead of cloning its pre-upgrade input. Per root direction, the stronger focused test and TypeScript check were rerun; the unchanged source did not require another 9,483-test run.

Graph maintenance was attempted faithfully. `npx graphify hook-rebuild` exited 1 because npm could not determine an executable. The installed `graphify portable-check .graphify` exited 1 because that CLI does not know `portable-check`. No graph, legacy sidecar, cache, branch, or worktree artifact was created.

## Real dev browser and durable recipient evidence

The browser pass used the Playwright CLI workflow against the restarted Node 22 dev server on port 3008 and dev/test Supabase project `emstjswhotsnyksqhqyf`. Both canonical manager and resident roles were verified from rendered portals. Their refreshed private storage states were saved outside the repository with mode 600; no credential or token is recorded here.

- Event: `80eb0801-755d-4cf8-be15-bff69eafb61c`, label `PRP473 C2 Resident 2204`, property `mgr-demo-lakeview` / 2100 Westlake Ave N.
- Manager UI rescheduled the event from the browser-local 11 AM-noon window to noon-1 PM. The preview was inspected at 1280 x 900 and 390 x 844. It showed the Pacific 9-10 AM new window, 8-9 AM previous window, property/address, and truthful account/contact fallback. SMS was visibly unavailable for this manager.
- `POST /api/portal-tour-inquiries/reschedule` returned HTTP 200 with `ok:true`, `guestNotification.inbox.sent:true`, sandbox email skipped, SMS not requested, and calendar sync true.
- Durable generation: `46a97330-3f8f-4e4f-a8ba-cd2cd2a68cdd`.
- Resident thread: `msg_inbox_1788671403204_8yxw`.
- Exact message id: `tour:80eb0801-755d-4cf8-be15-bff69eafb61c:rescheduled:46a97330-3f8f-4e4f-a8ba-cd2cd2a68cdd`.
- The authenticated resident opened that exact thread and rendered the complete persisted body. A repeated same-time submission through the manager UI returned HTTP 400 with `That is the time this tour is already booked for.` and did not append another lifecycle message.

Artifacts:

- `output/playwright/prp473-resumed-desktop-preview.png` - 1280 x 900
- `output/playwright/prp473-resumed-mobile-preview.png` - 390 x 844
- `output/playwright/prp473-resumed-resident-inbox.png` - 1200 x 739

## Limits and next phase

- Real handset delivery/receipts, STOP/START, inbound YES, alternate-time handset reply, actual email routing, and staging QA remain external acceptance. Provider sends were disabled, and this handoff does not claim handset delivery.
- The manager has no enabled SMS channel, so browser QA proves the connected tour mutation, truthful channel state, durable inbox append, recipient rendering, mobile layout, and repeat failure. Positive SMS reply races are hermetic module tests with real matching logic and mocked persistence/provider boundaries.
- Remote main/production remain at `2d1353af42c3a652be6cf8a69640468b453f4cea`; remote staging is absent. The dirty keeper intentionally remains on its original base. No merge/rebase or shipping action belongs to this execution phase.

## Fresh Astra review prompt

Run a fresh-context GPT-6 Astra review of the complete accumulated uncommitted PRP-473 diff in `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/3/AXIS-2` on keeper `akhil/backlog-repeat-issues`, base/current commit `0b6d56794407277761ad5f6c680a522e97db2e6d`. Read root/Akhil instructions, `docs/agents/akhil-feature-cycle.md`, the original plan and both prior correction plans/handoffs/reviews, both correction-2 security reports, `docs/plans/2026-09-10-prp-473-resumed-reply-fixes.md`, and this handoff. Independently review correctness, security, tenant and consent scope, complete planned/pending modern/legacy candidate inventory, definitive denial versus unreadable authority, conversation-key mismatch behavior, guard record/event/full-snapshot preservation through every final CAS retry, ambiguity, duplicate SID and alternate-time behavior, and test strength. Inspect all actual diffs and validation/browser evidence. Produce fresh dated security-review and bugbot reports for this final dirty snapshot. Do not edit source, write production data, contact providers, commit, push, merge, deploy, open a PR, update a tracker, or run no-mistakes.
