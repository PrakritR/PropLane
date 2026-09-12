# PRP-473 correction cycle 2 handoff

Date: 2026-09-10

Worktree: `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/3/AXIS-2`

Keeper: `akhil/backlog-repeat-issues`

Base/current commit: `0b6d56794407277761ad5f6c680a522e97db2e6d`

Plan: `docs/plans/2026-09-10-prp-473-correction-2.md`
Process: correction 2 of at most 2 under `akhil-feature-cycle`

This handoff returns the integrated final automatic correction to root for one fresh Astra review. Nothing was committed, pushed, promoted, ticketed, or sent to a real SMS/email provider. All cloud writes were task-specific QA fixtures in dev/test project `emstjswhotsnyksqhqyf`. `SMS_RUNTIME_ENABLED=0` and the SMS scheduler remained disabled.

## Correction 2 implementation

### Authoritative planned-tour owner propagation

- `src/lib/tour-planned-change.server.ts` now projects the stored `managerUserId` from the already authorized planned event and passes it through both real reschedule and cancel notification windows.
- The stored owner, rather than the actor or request body, reaches the real notifier, lifecycle trace, eligibility resolver, signed Reply-To builder, canonical inbox append, outbound thread context, and proposal recorder.
- `src/lib/tour-notification-delivery.server.ts` accepts the optional authoritative owner on the cancel window type, matching the shared internal notification contract.

### Upgrade-only legacy repair and generation safety

- `src/lib/tour-reschedule-sms-reply.server.ts` captures the selected legacy event/proposal snapshot: record and event identity, source inquiry, stored owner, normalized guest/work phone pair, exact window, row/proposal generation, version, status, conversation identity, request timestamp, and SMS origin/consent evidence.
- Legacy repair is an upgrade-only CAS. It cannot use the general new-proposal fallback, reopen a terminal proposal, replace a rotated sender, or claim success when no upgrade occurred.
- Every bounded CAS retry closes over the original snapshot. A changed owner, phone, work number, window, provenance, generation, status, version, conversation, or source is rejected.
- Planned and pending candidate selection plus final confirmation/follow-up CAS require exact current-row generation agreement. Only absent proposal generation plus absent row generation is treated as genuine generationless legacy state. Present-versus-missing fails closed.
- A late recorder for generation A cannot create or replace state after generation B is current, even at the same time window.
- A second race was reproduced during integration: after successfully upgrading A, the old recursive reread could confirm a newer B or repeatedly re-enter repair. The final code permits one guarded reread tied to the upgraded A snapshot and disables further repair on that path. If B appears, the reply returns stale and B remains unchanged.

## Delegate and correction evidence

- Fresh Terra owned only `src/lib/tour-planned-change.server.ts` and `src/lib/tour-reschedule-sms-reply.server.ts` for the planned production correction.
- Fresh Luna ran sequentially because a completed ghost agent consumed the fourth collaboration slot. Luna owned only `tests/unit/tour-lifecycle-sms-provenance.test.ts` and `tests/unit/tour-reschedule-sms-reply.test.ts`.
- Luna's first final focused pass under Node 22.23.0 passed 2 files / 32 tests.
- The integration review then added two actual-module race regressions. Before the guarded-reread fix, the Node 22 focused run exited 1: 27 existing tests passed, and both new tests failed because A confirmed B and repeated repair performed four writes.
- After the fix, `npx vitest run tests/unit/tour-reschedule-sms-reply.test.ts tests/unit/tour-lifecycle-sms-provenance.test.ts --maxWorkers=1` exited 0: 2 files / 34 tests.
- One early development-only Luna process inherited host Node 23.7.0. It is not counted as final evidence; every reported final gate below used explicit Node 22.23.0.

The lifecycle matrix invokes real confirmation/acceptance callers, real `reschedulePlannedTour` and `cancelPlannedTour`, the real shared notifier, and the real eligibility resolver. Only provider and persistence boundaries are hermetic. It covers:

- explicit form opt-in and legacy recipient-initiated conversation grants;
- positive owner/service/conversation propagation, provider invocation, canonical inbox append, signed Reply-To, and durable reply-proposal recording;
- `non_sms` with matching historical conversation evidence on both planned callers, specifically denied as `tour_sms_consent_missing` without provider invocation;
- legacy A to terminal/newer B changes, failed-CAS snapshot preservation, current-generation YES/follow-up, stale recorder, and deliberate generationless compatibility.

## Final validation

All final commands used `PATH=/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin:$PATH`, `NODE_OPTIONS=--max-old-space-size=4096`, `SMS_RUNTIME_ENABLED=0`, `SMS_OUTBOX_SCHEDULER_READY=0`, bounded workers, and one compiler at a time.

| Command | Result |
| --- | --- |
| `npx vitest run tests/unit/tour-lifecycle-sms-provenance.test.ts tests/unit/tour-reschedule-sms-reply.test.ts tests/unit/tour-planned-change.test.ts tests/unit/tour-confirm-google-sync.test.ts tests/unit/tour-guest-sms-consent.test.ts tests/unit/prp-473-tour-sms-eligibility.test.ts tests/unit/sms-conversation-log-dispatch.test.ts tests/unit/tour-notifications.test.ts tests/unit/tour-email-skips-sandbox.test.ts --maxWorkers=1` | Exit 0, 9 files / 110 tests |
| `npx vitest run tests/integration/webhooks/twilio-sms.test.ts tests/integration/public/property-lead-message.test.ts --maxWorkers=1` | Exit 0, 2 files / 11 tests |
| `npm run test:unit -- --maxWorkers=2` | Exit 0, 1,367 files / 9,458 tests, 284.65 seconds |
| `npm run lint` | Exit 0, 0 errors / 726 existing warnings |
| `npx tsc --noEmit --pretty false --incremental false` | Exit 0 |
| `npm run build` | Exit 0, Next 16.3.4 compiled, TypeScript passed, 385/385 pages generated |
| `git diff --check` | Exit 0 |
| `npm run ship:preflight` | Exit 1 as expected: missing `origin/staging`; dirty checkout and shell-local production configuration were warnings. Ten repository checks passed. No promotion was attempted. |

Root stopped only its Node 22 port 3008 server before build, then restarted it after build as root-owned session `51411`. No unrelated server was touched.

## Real dev and browser evidence

Browser tooling used the Playwright CLI wrapper with manager session `backlog`, config `/private/tmp/axis-backlog-playwright.json`, and the stored private manager state. A temporary `prp473-resident` session loaded the stored resident state and was closed after evidence capture. Both authenticated roles were verified in the rendered portal. The refreshed manager/resident states were saved back to `/Users/akhilvemuri/.local/share/proplane-codex/dev-test/` with mode 600; no credentials are copied into this artifact.

### Existing task-only C1 event

- Planned event: `dba5219a-2629-4b83-9cb4-aabf15f5a074`
- Source inquiry: `1116574c-1af4-454b-84b8-de2879378491`
- Label: `PRP473 C1 2107`
- Real manager time picker rescheduled it from `2026-09-14T21:00:00.000Z` to `2026-09-14T22:00:00.000Z`, preserving its 30-minute duration.
- Route response: HTTP 200, mutation `ok:true`, `guestNotification.inbox.sent:true`, sandbox email safely skipped, SMS not requested.
- Durable generation: `b3b2dba6-886c-4f8d-af8b-252aebafbb0e`
- Canonical resident-scope thread: `property_mgr_tjn521`
- Message id: `tour:1116574c-1af4-454b-84b8-de2879378491:rescheduled:b3b2dba6-886c-4f8d-af8b-252aebafbb0e`
- A repeat same-time submission through the same UI returned HTTP 400 with `That is the time this tour is already booked for.` and did not mutate the event.

### Task-unique canonical resident fixture

To prove the recipient surface rather than infer it from the manager account, the manager UI created one additional task-only planned event for the canonical resident. No shared seed or Morgan row was changed.

- Planned event: `80eb0801-755d-4cf8-be15-bff69eafb61c`
- Label: `PRP473 C2 Resident 2204`
- Property: `mgr-demo-lakeview` / 2100 Westlake Ave N
- Recipient: canonical private resident account referenced by `tests/fixtures/qa-accounts.mjs`
- Initial window: `2026-09-17T14:00:00.000Z` to `2026-09-17T15:00:00.000Z`
- Rescheduled window: `2026-09-17T15:00:00.000Z` to `2026-09-17T16:00:00.000Z`
- Route response: HTTP 200, `guestNotification.inbox.sent:true`, sandbox email safely skipped, SMS not requested.
- Durable generation: `0f5ed54d-66ed-45b3-a1ae-603584e47983`
- Canonical resident thread: `msg_inbox_1788671403204_8yxw`
- Message id: `tour:80eb0801-755d-4cf8-be15-bff69eafb61c:rescheduled:0f5ed54d-66ed-45b3-a1ae-603584e47983`
- The authenticated resident opened that exact Communication thread and the full persisted body, including new/previous Pacific time, property, address, and reachable account follow-up path.

Artifacts:

- `output/playwright/prp473-correction2-desktop-preview.png` - 1280 x 900
- `output/playwright/prp473-correction2-mobile-persisted.png` - 390 x 844
- `output/playwright/prp473-correction2-resident-inbox.png` - authenticated recipient thread

Review URL: `http://localhost:3008/portal/tours/upcoming`

## Graph and repository state

- `npx graphify hook-rebuild` exited 1 because npm could not determine an executable.
- The installed older CLI's `graphify portable-check .graphify` exited 1 because `portable-check` is unknown.
- No legacy `graphify-out` artifact or branch/worktree/cache sidecar was created or staged.
- The full existing uncommitted PRP-473 implementation and unrelated root planning/security artifacts remain preserved. Copied `docs/agents/akhil-feature-cycle.md`, backlog notes, and sibling notes were not edited.
- Remote `main` advanced independently to `580d189876433cef86c0c850d8858cde65708e4a`; root verified no overlap with the PRP-473 source/test files. This keeper remains at the agreed base without merge or rebase.

## Remaining limits

- Real Twilio handset delivery, delivery receipts, STOP/START, and inbound YES round trip remain external QA. Managed SMS stayed disabled and no incident/contact number was used.
- The manager's dev account has no enabled SMS channel, so the browser correctly rendered `SMS (not enabled)`. Positive selected-SMS and selected-channel failure behavior are covered at the real server caller/resolver boundary with hermetic provider tests, not represented as handset evidence.
- Sandbox email skip was verified. No real Resend delivery was attempted.
- Staging does not exist in this checkout, so staging QA and promotion remain unavailable.
- The pre-existing Pacific message versus Indiana browser-list display distinction remains outside this correction.
- This is the final automatic correction. If the fresh reviewer finds a remaining defect, report it rather than starting a third correction.

## Fresh final review prompt

Run one fresh-context GPT-6 Astra review of the complete uncommitted PRP-473 diff against `docs/plans/2026-09-10-prp-473.md`, `docs/plans/2026-09-10-prp-473-correction-1.md`, and `docs/plans/2026-09-10-prp-473-correction-2.md`. Read this handoff, `docs/plans/2026-09-10-prp-473-review-2.md`, and both correction-1 security reports. Review correctness, security, tenant/consent scope, legacy upgrade-only CAS behavior, guarded post-repair reread, generationless compatibility, actual planned caller propagation, inbox/email/SMS outcomes, tests, and real browser evidence. Produce fresh mandatory security-review and bugbot reports. Do not edit source, write external data, send providers, commit, push, promote, open a PR, update a tracker, or run no-mistakes. Because this is correction cycle 2, report any remaining findings to Akhil and do not launch a third automatic correction.
