# PRP-473 correction cycle 1 handoff

Date: 2026-09-10

Worktree: `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/3/AXIS-2`

Keeper: `akhil/backlog-repeat-issues`

Base/current commit: `0b6d56794407277761ad5f6c680a522e97db2e6d`
Process: correction 1 of at most 2 under `akhil-feature-cycle`

This handoff returns the integrated correction to root for a fresh Astra review. Nothing was committed, pushed, promoted, ticketed, or sent to a real SMS/email recipient. Production and staging were not written. All cloud writes described below targeted dev/test project `emstjswhotsnyksqhqyf`; `SMS_RUNTIME_ENABLED=0` remained set for validation commands.

## Implemented corrections

### 1. Provenance survives every live confirmation/change path

- `confirmTourInquiry` and the separate live `acceptTourInquiry` calendar-tool path both copy the server-owned `smsOrigin` and boolean `smsConsent` into planned events.
- `inquiryFromPlannedEvent` carries that provenance into reschedule/cancel notification policy.
- Known `non_sms` inquiries cannot become ambiguous legacy rows merely by being confirmed.
- Projection regressions cover both confirmation callers and both planned change callers.
- `tests/unit/tour-lifecycle-sms-provenance.test.ts` confirms a `non_sms` inquiry, consumes the resulting planned-event projection at the actual reschedule notification boundary, and uses the real `resolveTourSmsEligibility`. A matching historical conversation grant is present in the fake ledger, but the gate does not consult it, materialize a purpose grant, or call the mocked provider.

### 2. Derived consent is revocable through retry and dispatch

- Purpose grants materialized from `recipient_initiated_inbound` or `twilio_start` store explicit conversation-derived evidence and preserve the source event's original timestamp.
- Retry resolution revalidates the exact manager, normalized phone, Messaging Service, prospect conversation key, transactional class, and current source grant. Explicit tour opt-in and independently restored purpose consent remain distinct.
- The managed dispatcher performs the same final revalidation for the exact lifecycle purpose set: `tour_request_received`, `tour_request_removed`, `tour_confirmed`, `tour_rescheduled`, and `tour_canceled`.
- The exact purpose set intentionally excludes manager notification and reminder purposes, avoiding a broad `tour_*` policy change.
- Provider-boundary regression proves a delayed derived outbox item is refused after source revocation without calling the provider.

### 3. Legacy proposals upgrade through a safe CAS only

- A legacy pending/planned reply proposal is revalidated and CAS-upgraded only when exactly one eligible actionable candidate exists.
- The upgrade preserves original work number, generation/version, guest phone, window, and status.
- Changed owner/phone/work number/window/generation, ambiguous candidates, missing/unreadable evidence, canceled rows, and terminal rows remain closed.
- Same-operation terminal retries return false and do not reopen or claim to repair the proposal.
- The CAS-race fixture now proves it reached the contested read.

### 4. Default copy is truthful and conservative previews remain aligned

- Shared default builders advertise SMS YES only when SMS is selected and server-authorized, and advertise email reply only when email is selected and a valid signed Reply-To is attached.
- Otherwise the default uses the existing context-derived resident account/tour route. Guest-without-profile, configured/unconfigured Reply-To, invalid-token fallback, sandbox skip, and selected/no-SMS behaviors have behavioral coverage.
- Server delivery attaches the same signed Reply-To used to authorize email-reply copy. Unknown manager prose remains unchanged.
- The portal preview deliberately cannot authorize SMS or inspect Reply-To secrets, so its default is the conservative account path. Delivery now recognizes that generated preview and preserves it byte-for-byte when it makes no claim the server cannot honor. A generated preview that overclaims a path is replaced by the server-authoritative safe default.
- When no client preview body is supplied, the server default still uses an available signed email reply or authorized SMS path.

Known UI limitation for reviewer judgment: changing the existing Send via selector to SMS does not dynamically rewrite the already-open conservative preview to advertise YES. It remains truthful and the delivered body stays aligned, but the preview does not surface the richer selected SMS path. No client eligibility is trusted as authorization.

## Main source and test files

Correction source includes:

- `src/lib/sms/tour-sms-eligibility.server.ts`
- `src/lib/sms/owner-sms-dispatcher.server.ts`
- `src/lib/tour-inquiry-confirm.server.ts`
- `src/lib/tour-inquiry.server.ts`
- `src/lib/tour-planned-change.server.ts`
- `src/lib/tour-reschedule-sms-reply.server.ts`
- `src/lib/tour-notification-delivery.server.ts`
- `src/lib/tour-notifications.ts`
- `src/components/portal/pro-tours.tsx`
- the existing initial PRP-473 context/tool/origin files listed by the original handoff
- `docs/agents/sms-system.md`
- `docs/agents/tours-scheduling.md`

Focused regressions include:

- `tests/unit/prp-473-tour-sms-eligibility.test.ts`
- `tests/unit/tour-lifecycle-sms-provenance.test.ts`
- `tests/unit/sms-conversation-log-dispatch.test.ts`
- `tests/unit/tour-reschedule-sms-reply.test.ts`
- `tests/unit/tour-guest-sms-consent.test.ts`
- `tests/unit/tour-confirm-google-sync.test.ts`
- `tests/unit/tour-planned-change.test.ts`
- `tests/unit/tour-notifications.test.ts`

Root's backlog/PRP-469/tour-sibling planning artifacts were preserved and are not correction implementation claims.

## Final validation evidence

All commands used Node `22.23.0`, bounded workers, and one compiler at a time.

| Command | Result |
| --- | --- |
| `npx vitest run tests/unit/tour-guest-sms-consent.test.ts tests/unit/tour-confirm-google-sync.test.ts tests/unit/tour-planned-change.test.ts tests/unit/prp-473-tour-sms-eligibility.test.ts tests/unit/tour-reschedule-sms-reply.test.ts tests/unit/sms-conversation-log-dispatch.test.ts tests/unit/tour-notifications.test.ts --maxWorkers=1` | Exit 0, 7 files / 95 tests |
| `npm run test:unit -- --maxWorkers=2` | Exit 0, 1,366 files / 9,446 tests, 292.40 seconds. This covered all final production source. |
| `npx vitest run tests/unit/tour-lifecycle-sms-provenance.test.ts --maxWorkers=1` | Exit 0, 1 file / 1 test. This hermetic boundary test was added after the broad run; no production source changed afterward. |
| `npx tsc --noEmit --pretty false --incremental false` | Exit 0 after all source and tests |
| `npm run lint` | Exit 0, 0 errors / 726 existing warnings |
| `npm run build` | Exit 0 after root stopped the exact dev server; Next 16.3.4 compiled, TypeScript passed, 385 static pages generated |
| `git diff --check` | Exit 0 |
| `npm run ship:preflight` | Exit 1 as expected: missing `origin/staging`, dirty checkout, and shell-local production configuration warnings. Feature checks inside preflight passed. No promotion attempted. |

Earlier supporting runs before the final late integrations also passed the complete tour/SMS unit inventory (110 files / 740 tests) and the two relevant Twilio/SMS integration files (2 files / 15 tests). They are supporting evidence, not substitutes for the final gates above.

Process correction: three overlapping task-owned TypeScript compiler trees (parents/children `89443/89471`, `89830/89849`, `91659/91866`) were identified and terminated as redundant. They are not passing checks. The first later single typecheck exposed a provenance typing error and exited 2; the type guard/timestamp validation was corrected, and all subsequently reported single typechecks passed. An initial focused test run also exposed three fixture/source-assertion mismatches; those were corrected before the reported green runs.

## Browser and durable dev evidence

Browser: Playwright CLI wrapper, session `backlog`, canonical manager account from the private QA state. Refreshed auth was saved only to `/Users/akhilvemuri/.local/share/proplane-codex/dev-test/manager-state.json` and chmod 600.

Task-unique inquiry:

- inquiry id `1116574c-1af4-454b-84b8-de2879378491`
- normalized request record `partner_inquiry_request_1116574c-1af4-454b-84b8-de2879378491_0`
- label `PRP473 C1 2107`
- property `mgr-demo-pioneer` / The Pioneer
- initial durable singleton window `2026-09-14T20:00:00.000Z` to `2026-09-14T20:30:00.000Z`
- initial singleton stored `smsOrigin: non_sms`; no Morgan seed was edited or reset

After the normalized request was approved, the same task-owned record became planned event `dba5219a-2629-4b83-9cb4-aabf15f5a074`. The real manager time picker and notification preview were exercised on desktop 1280 x 900 and mobile 390 x 844. Preview selected PropLane + Email, SMS remained off, and the body contained the new/old time, property, room, and reachable account route without promising SMS YES or email reply.

The reschedule request body preserved that exact preview body and sent `deliverViaEmail:true`, `deliverViaSms:false`. Route `POST /api/portal-tour-inquiries/reschedule` returned HTTP 200 with mutation `ok:true`; the sandbox guest notification reported inbox not saved, email safely skipped, and SMS not requested/skipped. No real provider send occurred.

After reload and settled server sync:

- planned singleton updated at `2026-09-10T21:14:24.567Z`
- durable event window `2026-09-14T21:00:00.000Z` to `2026-09-14T21:30:00.000Z`
- source inquiry id remains the task-unique id
- `smsOrigin: non_sms` remains preserved
- the task row remained visible after mobile reload

Artifacts:

- `output/playwright/prp473-correction1-desktop-preview.png`
- `output/playwright/prp473-correction1-mobile-preview.png`
- `output/playwright/prp473-correction1-mobile-persisted.png`

Observed outside this correction's copy/security scope: the notification builder renders Pacific time (`2:00 PM`) while the manager list in this Indiana-hosted browser rendered the same durable `21:00Z` event as `5:00 PM`. The mutation and durable ISO values agree; this handoff does not claim that pre-existing display-time discrepancy is resolved.

Review URL: `http://localhost:3008/portal/tours/upcoming`

Root restarted the Node 22 server on pinned port 3008 as session `64361` and is leaving it alive for review.

## Graph status

`npx graphify hook-rebuild` exited 1 because npm could not determine an executable. The installed older CLI's `graphify portable-check .graphify` also exited 1 with unknown command. The established fallback extraction remains at `/private/tmp/prp473-graphify/graphify-out/graph.json`. No incompatible graph artifact or invented TypeScript runtime was committed.

## Remaining external acceptance

- Fresh Astra correction review is required.
- Real handset/Twilio delivery, receipt status, and inbound YES acceptance remain external QA. Managed runtime stayed disabled and no live number was used.
- No staging remote exists in this checkout, so staging QA and any promotion remain unavailable and were not attempted.
- Do not mark PRP-473 resolved from this handoff alone.
