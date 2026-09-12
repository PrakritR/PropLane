# PRP-473 root verification notes

Keeper `akhil/backlog-repeat-issues`, HEAD `0b6d56794407277761ad5f6c680a522e97db2e6d`, uncommitted initial execution under fresh Astra review. This supplements the execution handoff, not an approval.

## Resumed-cycle root checkpoint

Akhil explicitly requested another cycle for the two remaining findings. Root re-ran the correction-2 bugbot report's exact no-file reproduction against the preserved dirty reply module before new implementation. Exit 0 reproduced all five final-CAS omissions (`confirmed`, two writes, contested read) and the two-legacy/one-modern ambiguity defect (`confirmed`, one write). This is red-behavior evidence, not a passing product test.

Fresh plan: `2026-09-10-prp-473-resumed-reply-fixes.md`. Fresh Sol-medium manages Luna's failing regressions first and Terra's implementation afterward. The root manager browser snapshot still displayed task event `80eb0801-755d-4cf8-be15-bff69eafb61c` with its correction-2 stored window; no new browser mutation was performed at this checkpoint. Saved role states and private README permissions remain 600, parent directory 700.

Read-only remote audit now identifies both main and production at `2d1353af42c3a652be6cf8a69640468b453f4cea`, with no remote staging branch. The keeper base is unchanged. New main dependency tests confirmed by `git ls-tree`, to run after captain integration rather than on this older base: `manager-comms-eligibility.test.ts`, `manager-work-email-exposure.test.ts`, `manager-reachability-for-resident.test.ts`, `resident-manager-contact.test.ts`, `manager-sms-access.test.ts`, `manager-sms-entitlement.test.ts`, `manager-assistant-email-address.test.ts`, plus the entire PRP-473 affected set. No merge, deployment or production data mutation occurred.

Root inspected the active shared `post-commit` hook completely. It contains only graphify integration and exits for pooled linked worktrees before launching a rebuild. No active pre-commit/pre-push hook or configured hooksPath was found. This avoids accidentally invoking the forbidden no-mistakes pipeline during any later approved keeper commit, without disabling hooks.

### Independent fixed-behavior replay

After Sol reported intended-stable source, root executed the retained correction-2 security harness via Node22 `transpileModule`, with the actual active-tour helper and bugbot's distinct future dates/properties. To reach the intended final-CAS race under the new fail-closed identity check, both the fixture's stored conversation key and mocked resolver key were made the same canonical `manager-1:prospect:+12065550100`. No race timing or storage semantics changed. Assertions were changed from demonstrating the bug to requiring correct behavior, including the exact competitor field being preserved and the inbound SID remaining absent.

Command environment: Node22.23.0, `NODE_OPTIONS=--max-old-space-size=4096`, `SMS_RUNTIME_ENABLED=0`, `SMS_OUTBOX_SCHEDULER_READY=0`. Exit 0. All five omitted-field probes reached contested read 6 and returned `stale`, with only the eligibility repair write (one write, no confirmation). The 2-legacy/1-modern probe returned `ambiguous`, zero writes, all three statuses `awaiting_reply`. Actual provider and persistence boundaries remained mocked; this is independent code behavior proof, not a handset or connected-DB claim. Final review and full checks are still required.

Reply source SHA-256 for that replay: `a75cd1caf2d02bf6a4da3ba61353240fd0f765b63d64bf5e14d9ebcc9a1ecbe5`, unchanged on root's subsequent checks. During test integration root requested three concrete strength improvements: assert the post-guard contested read and advancing token, keep all previously checked fields unchanged in final-CAS retry cases, and only activate a cross-record same-id candidate after successful repair. The retry competitor must be cloned from the already-upgraded row, not the original marker-less fixture, so that the full snapshot guard is the actual rejection reason.

### Resumed connected-path verification

Root independently read the dev database with an exact-hostname assertion for `emstjswhotsnyksqhqyf.supabase.co`; Node22 command exit 0, read-only, no provider calls. Event `80eb0801-755d-4cf8-be15-bff69eafb61c` still belongs to canonical manager `c02c7ffd-50ec-47d0-acf2-82928be6db27`, now stores Sep17 `16:00:00.000Z` through `17:00:00.000Z`, generation `46a97330-3f8f-4e4f-a8ba-cd2cd2a68cdd`. Schedule updated `2026-09-10T23:36:36.681+00:00`.

Resident-scope thread `msg_inbox_1788671403204_8yxw`, canonical resident owner `f4290f7c-31c7-469e-b0bb-859f5ce37f46`, contains exactly one message `tour:80eb0801-755d-4cf8-be15-bff69eafb61c:rescheduled:46a97330-3f8f-4e4f-a8ba-cd2cd2a68cdd`. It states new Pacific 9-10AM, previous 8-9AM, the actual task property/address and existing account route. Thread updated `23:37:58.819+00:00`.

Root visually inspected `prp473-resumed-resident-inbox.png`, mobile preview and desktop preview under `output/playwright/`; resident role and exact notification are visible, and mobile composer/send control remains on-screen. Both saved browser states retain mode600. Executor reports the actual reschedule route returned inbox sent true and same-time repeat returned HTTP400 without another notification; these HTTP observations are attributed to Sol, while the durable rows and screenshot inspection above are independent root evidence. Root stopped server51411 before build and restarted pinned3008 as session74874 with both SMS runtime/scheduler flags disabled.

## Final-diff full unit rerun

Root ran `env PATH=/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin:$PATH NODE_OPTIONS=--max-old-space-size=4096 npm run test:unit -- --maxWorkers=2` after the final email-reply patch. Session81927 completed **exit0: 1,366 files and 9,434 tests passed**, duration339.86s, starting16:22:37 local (20:22:37 UTC). Source remained unchanged during the run. This verifies the final initial-execution diff, but does not clear the independent review findings or verify any later correction diff. Earlier whole-suite results belong to the execution handoff.

## Shared dev fixture changed after initial QA

Reviewer refreshed the saved manager login and saw the cached Morgan tour change after server sync. Root read the dev database only (`emstjswhotsnyksqhqyf`) at 20:29 UTC:

- `portal_schedule_records.id = axis_admin_partner_inquiries_v1` was updated at `2026-09-10T20:06:57.332Z`, with `manager_user_id = 9684a955-b174-4952-8063-f4e4aada599d`.
- Inquiry `seed-pending-c02c7ffd-c` now has `propertyId = mgr-demo-pioneer`, `proposedStart = 2026-09-11T20:00:00.000Z`, `proposedEnd = 2026-09-11T21:00:00.000Z`, slot key `2026-09-11:26`, and no reschedule generation.
- No matching per-inquiry normalized event row was found.
- Initial QA's persisted screenshot file was saved at 19:59 UTC. Thus the stored singleton changed after that screenshot. The review observation alone does not prove the initial mutation failed to persist.
- Root performed no tour writes after the initial seed. Root's full unit rerun started after this singleton update. The other root mutation was a dev-only resident inbox probe, recorded separately for PRP-469.

Correction QA should use a task-unique inquiry id, then verify both UI after settled server sync and exact durable record/window/generation. Preserve all unrelated shared dev data; do not wipe or reset the shared canonical seed to make screenshots match.

## Review server and reusable accounts

Root restarted the pinned Node22 dev server on port3008, session80937, after Sol's server was no longer reachable. Reviewer reauthenticated the canonical dev manager and refreshed private `manager-state.json` with mode600. Private account reference directory is `/Users/akhilvemuri/.local/share/proplane-codex/dev-test/`. Canonical fixture credentials remain in `tests/fixtures/qa-accounts.mjs`; no new account or production login was required.

## Correction-cycle coordination checkpoint

During correction1 integration, root identified the additional live `acceptTourInquiry` caller in `tour-inquiry.server.ts`, reached by the registered calendar tool. Its planned-event projection omitted both SMS consent fields. The correction plan now includes the narrow carry-through change and tests, without a booking-core refactor.

Sol reported an intermediate green pass of 1,366 unit files / 9,445 tests, lint with 0 errors / 726 existing warnings, TypeScript, and a 385-page production build. These results preceded the late caller/default-copy integration adjustments and are not final-diff evidence. Final checks must be recorded separately in the correction handoff.

Root independently viewed correction1 desktop/mobile preview screenshots and the mobile persisted tour row for task fixture `PRP473 C1 2107`. Canonical timestamps still need the execution handoff's durable-row evidence; visual list time alone is insufficient because list and modal use different display zones. Root also requested explicit actual-resolver lifecycle regression evidence: existing notifier/projection mocks by themselves do not meet that correction-plan requirement.

Private manager browser state was refreshed after this QA and saved mode600, as reported by Sol. Root dev server was stopped for the intermediate build and restarted on pinned3008 as session29131. No provider send or production write was introduced by these checks.
# Correction-2 independent browser/data verification

During the final correction, root independently read dev/test project `emstjswhotsnyksqhqyf` using a Node22 script guarded against any other database hostname. Read-only query exit 0. No provider calls or data writes occurred in this verification.

- Task event `80eb0801-755d-4cf8-be15-bff69eafb61c` belongs to canonical manager `c02c7ffd-50ec-47d0-acf2-82928be6db27`, persists `2026-09-17T15:00:00.000Z` to `16:00:00.000Z`, and carries generation `0f5ed54d-66ed-45b3-a1ae-603584e47983`. Schedule singleton update: `2026-09-10T22:05:17.953+00:00`.
- Canonical resident-scope thread `msg_inbox_1788671403204_8yxw`, owner `f4290f7c-31c7-469e-b0bb-859f5ce37f46`, contains message `tour:80eb0801-755d-4cf8-be15-bff69eafb61c:rescheduled:0f5ed54d-66ed-45b3-a1ae-603584e47983`. The body gives Sep17 8-9AM Pacific, old 7-8AM, Lakeview street address, and existing account/contact route. Thread updated `22:06:12.844+00:00`.
- Root visually inspected `output/playwright/prp473-correction2-resident-inbox.png`: Resident portal, exact Test Manager conversation open, message body and reply composer visible. This establishes recipient-surface visibility in addition to persistence, not handset or inbound-email provider delivery.
- Root inspected the mobile persisted task-row image and the corrected 1280x900 desktop preview image. An earlier file carrying the desktop name was actually mobile-sized; the executor replaced it with genuine desktop evidence. The final desktop image is a reopened preview, not a second successful move.

The root clarification of the in-scope post-repair race is retained in correction-2 plan: original selected A must survive through reply consumption, not just the upgrade write. Execution added bounded reread guard and tests for newer B after successful repair and repeated repair re-entry; final independent Astra review remains required.
