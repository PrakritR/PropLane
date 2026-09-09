# Linear batch review and validation

Review branch: `akhil/linear-batch-qa-20260908`, based on `6f24d93b712f140d16af5f10e14b1fd88edd61aa`. Implementation tip before this report: `42938b5db7d2ce0d96215db46b08bfb3cf72bc84`.

Review URL: http://localhost:3007/portal/communication

## Scope and integration order

Akhil's In Progress manager-SMS ticket was handled first. Seventeen assigned tickets now have implementation branches; PRP-450 remains deferred because server-side listing normalization/charges and Prakrit's active listing work must settle first. PRP-424's existing staging status was left alone. The [PRP-450 plan](../plans/2026-09-09-prp-450.md) records the prerequisite contracts, file ownership, safe parallel preparation and sequential acceptance gates.

| Tickets | Keeper | Implementation commits | Dependency |
| --- | --- | --- | --- |
| PRP-434 | akhil/prp-434-manager-sms | 1657c6695 | Base |
| PRP-435/436/439/441/443 | akhil/prp-435-leasing-answers | 4e81888ef | Base |
| PRP-442 | akhil/prp-442-person-threads | 4be523016 | Base |
| PRP-446 | akhil/prp-446-approval-sms | 353cafb23, f80194119, 8fc1eb703, f2c99ee66, 52b5966e9 | Shared inbox identity |
| PRP-437/444/445 | akhil/prp-437-notification-delivery | 86a618e72 | Scoped notification identity |
| PRP-438 | akhil/prp-438-nearby-transit | 1e78db8c1, 04e115ff6, 0b597600d | Leasing facts |
| PRP-440/447 | akhil/prp-440-447-tour-threads | 67fe511c7 | PRP-442, PRP-446, tour generations |
| PRP-451 | akhil/prp-451-rent-reminder-sms | f316fb1cb | Shared SMS dispatcher and existing-thread identity |
| PRP-448/449 | akhil/prp-448-449-lease-notifications | 82449af03, 45a38f713 | PRP-451 channel outcomes and additive migrations |
| PRP-446 follow-up | akhil/prp-446-approval-lease-sync | 1a1f0665c | Combined approval path |

Use the combined keeper for review. The lease notification keeper requires the shared PRP-451 outcome contract; its branch is not a substitute for combined validation. No protected branch was merged or promoted and no PR was opened.

## Behavior and review

Typed tools retain authenticated owner scoping. Leasing answers now expose only sourced listing facts and mapped transit results. SMS actions retain exact verified conversation identity and distinguish provider submission, queued/unknown results, failures and unavailable channels. Inbox changes preserve scoped resident/manager threads and message direction. Tour reschedule replies are bound to a persisted generation and exact phone/work-number/window; ambiguous or stale replies cannot confirm another tour.

Lease transitions and pending notification intents persist atomically. Claimed retry rows have fresh per-row leases and guarded finalization. Email, inbox and SMS retries retain completed legs; an explicit SMS deferred timestamp survives email failures during quiet hours. Submitted SMS is distinct from handset delivery.

Approval browser QA found two additional issues that were fixed: opting out now clears both external channels, and approval only mirrors unsigned draft rows instead of replaying every signed lease. A subsequent successful server inventory refresh can recover a draft missing after the old failed replace-all request.

Dated security and bug reviews for each lane live beside this report. They retain reviewed source hashes, findings, corrections and focused-test evidence. Cache/egress review uses bounded process-local transit cache/queues and existing inbox synchronization. No new native navigation or platform-specific UI was introduced.

## Real dev/test checks

Only dev/test project `emstjswhotsnyksqhqyf` was written. Three additive migrations were applied through `npm run db:push` using an isolated directory matching remote migration history. Each dry run listed exactly the intended new migration. No historical migration replay, production/staging write, seed wipe or protected listing write occurred.

A rollback-only SQL test verified atomic lease/event failure rollback, durable pending delivery, monotonic CAS, stale-write rejection, replay deduplication, recipient binding and anon/authenticated RPC denial. A follow-up query confirmed zero temporary lease/event fixtures. Schema queries verified the SMS log-repair fields and typed SMS deferral timestamp.

Earlier canonical seeded manager login was exercised on desktop and mobile Communication and listing preview. The supplied password correction was subsequently rejected for the Akhil manager account and both canonical manager/resident accounts; no password was reset and no older password was retried after the correction. Resident browser acceptance is pending a matching login.

Real read-only OpenStreetMap provider checks verified nearby BART and bus results in San Francisco. The actual leasing registry/model also queried seeded Cascade Lofts, named Seattle bus stops, reported no BART within 3.2 km and declined to invent walking times or frequency. Deployed map-service configuration and real prospect SMS remain pending.

The manager browser approved seeded Ethan with PropLane only and Olivia with the explicit no-message option. Both approval requests returned 200. Ethan's approval exposed a separate lease mirror 409 against legacy signed sibling data; the narrow recovery fix is included. The final lease recovery browser check stopped when the manager refresh token was rejected and the app returned to sign-in. A read-only database query still showed the two missing drafts; their backfill is covered by the focused recovery regression but is not claimed browser-verified.

The actual manager assistant UI completed the generic due-soon send_message flow to the canonical test resident with subject `QA-451-DUE-SOON-20260909-0348`. The confirmation stored the portal message and reported email/SMS unavailable. Communication showed the exact recipient/body, and a 390x844 screenshot verified the mobile thread and compose/navigation controls. This used the earlier authenticated manager session before it expired; no fresh-login success with the corrected password is claimed.

No external SMS/email or handset receipt is claimed. Local SMS runtime stayed disabled; the test manager has no active work number. Real phone acceptance remains pending.

## Combined automated gates

Full lint exited 0 with 705 warnings and no errors. The first combined unit run exited 1: 9,196 tests passed, with two stale contract expectations. The transit tool was added to the strict registry expectation (26 focused tests passed); the now-canonical approval route was moved from the legacy-role deferral list to the stronger migrated-route guard (five focused tests passed). No detector or authorization check was weakened. The corrected complete suite exited 0: all 9,198 tests across 1,332 files passed (487.06 seconds). The final combined TypeScript check also exited 0. The final production build exited 0 using `PROPLANE_LOW_MEMORY_BUILD=1 NODE_OPTIONS=--max-old-space-size=4096 npm run build`. Full browser E2E was not completed because the dev login is currently rejected. This is a keeper handoff, not staging or production acceptance.

## Linear state

Earlier scope/progress comments were posted and implementation cards moved to In Progress as work began. No card was marked Done or Ready for staging based on mocked provider tests. Both available Linear credentials later began returning authentication errors; the final verification-comment batch failed before its first write. Remaining board updates require refreshed Linear access.

The requested graph hook could not run because the installed npx package exposes no executable. The installed graphify AST update fallback completed with 26,621 nodes and 87,784 edges; 11 pre-existing parser warnings remain. These ignored local artifacts were not committed, and no TypeScript-backed graph runtime is claimed.
