# PRP-473 resumed fresh Astra review

Date: 2026-09-10. Worktree `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/3/AXIS-2`. Keeper `akhil/backlog-repeat-issues`. Base and independently observed HEAD: `0b6d56794407277761ad5f6c680a522e97db2e6d`.

Disposition: approve this accumulated PRP-473 snapshot for keeper handoff. No new actionable correctness or security finding was established. Both remaining P2 findings from review 3 are closed. No further correction cycle is required for this snapshot. This is not production approval, a protected-branch integration instruction, or a claim that PRP-473 handset acceptance is complete.

## Scope and review isolation

Reviewed the complete dirty implementation, not merely the resumed reply delta: 13 source files, 10 changed/new test files, and the two SMS/tours architecture notes. The source scope is `src/components/portal/pro-tours.tsx`, `src/lib/agent/leasing-sms-agent.server.ts`, `src/lib/sms/owner-sms-dispatcher.server.ts`, untracked `src/lib/sms/tour-sms-eligibility.server.ts`, `src/lib/tools/context.ts`, `src/lib/tools/domains/tours.ts`, `src/lib/tour-inquiry-confirm.server.ts`, `src/lib/tour-inquiry-create.server.ts`, `src/lib/tour-inquiry.server.ts`, `src/lib/tour-notification-delivery.server.ts`, `src/lib/tour-notifications.ts`, `src/lib/tour-planned-change.server.ts`, and `src/lib/tour-reschedule-sms-reply.server.ts`.

Test scope includes the eight tracked PRP-473 unit-test changes and untracked `tests/unit/prp-473-tour-sms-eligibility.test.ts` and `tests/unit/tour-lifecycle-sms-provenance.test.ts`. Copied `docs/agents/akhil-feature-cycle.md`, unrelated backlog/sibling investigations, and root-checkout user edits are excluded. No source/test edit, database write, provider send, credential change, commit, push, merge, deployment, tracker operation, or no-mistakes invocation occurred in this review.

Read the root and matching Akhil instructions, feature-cycle skill and repository workflow, ship gate, relevant tour/SMS/tool/inbox contracts, original plan, both correction plans and prior lead reviews, correction-2 mandatory reports, current resumed plan/handoff and root verification. Fresh mandatory security-review and Bugbot delegates ran sequentially under the available slot limit. Their reports are retained at:

- `docs/security/2026-09-10-prp-473-resumed-security-review.md`
- `docs/security/2026-09-10-prp-473-resumed-bugbot.md`

## Closed findings

### Closed P2: final reply consumption lost the legacy snapshot

The original complete snapshot predicate remains at `src/lib/tour-reschedule-sms-reply.server.ts:100`, with its upgraded-shape adapter at `:119`. The pending final CAS now receives the guard and evaluates that same predicate at `:447`; planned YES and alternate-time terminal mutations evaluate it at `:582`. The mutation callback closes over the original snapshot, so all bounded CAS retries retain source inquiry, event, owner, phone pair, window, row/proposal generation, version/status, conversation key, requested timestamp, origin and stored consent. Target selection also binds the record singleton and event id at `:538`, preventing same-id planned/pending substitution.

The focused tests exercise the contested read after upgrade and guarded reread, separately varying all five formerly omitted fields for planned and pending proposals. Retry cases at `tests/unit/tour-reschedule-sms-reply.test.ts:669` clone the already-upgraded row, alter only an omitted discriminator, advance its token, force a failed final CAS and assert the competitor remains exactly intact without an inbound SID. This is meaningful regression coverage of the reported gap, rather than a test that rejects only because a version, id, eligibility marker or terminal status also changed. Planned alternate-time coverage ensures a delivered notice cannot authorize a changed final target. Pending alternate-time remains the existing non-terminal manager follow-up path.

### Closed P2: mixed legacy/current proposals bypassed ambiguity

The shared candidate predicate at `src/lib/tour-reschedule-sms-reply.server.ts:341` receives both complete loaded inventories at `:512`. Structural checks retain owner, guest/work-number pair, current window, version, generation and active/pending status. Every structurally actionable legacy row reaches the existing eligibility resolver; only the narrow explicit denial set at `:332` removes one definitively. Unknown errors, exceptions, unreadable authority and a resolved/stored conversation-key mismatch remain unresolved. `:520` refuses confirmation when uncertainty remains or multiple candidates are actionable. Only one safely identified legacy target is upgraded, and its original guard survives the reread and consumption.

Regressions cover two legacy plus one modern, one legacy plus modern, legacy-only ambiguity, mixed planned/pending rows, unknown authority, key mismatch, definitive denial, exclusions and generationless compatibility. The modern candidate is not chosen simply because other candidates lack the new marker. Ambiguity and alternate-time notification failures retain actionability and return an honest unavailable result.

## Accumulated behavior and other review dimensions

The prior provenance and owner corrections remain sound. Public creation strips incoming origin metadata; leasing SMS requests bind the normalized model-supplied phone to server sender context; voice/email cannot inherit SMS origin. Both actual confirmation writers preserve origin. Planned cancel/reschedule retain the authorized stored owner through the real notifier, consent, signed Reply-To, canonical inbox append and proposal recording. The lifecycle tests now call actual confirmation/acceptance, planned changes, notifier and eligibility resolver, mocking persistence and provider boundaries. Positive explicit opt-in and legacy conversation paths establish owner/service/conversation propagation; negative non-SMS paths fail specifically with `tour_sms_consent_missing`.

Conversation-derived purpose grants retain trusted source evidence and timestamps. The resolver and five-purpose dispatch guard revalidate their current authority without overriding suppression or purpose revocation. Independently restored purpose consent stays distinct. No schema, route, RLS privilege or separate consent system was introduced. Modern proposals retain their server-recorded eligibility semantics; the compatibility path adds current authorization before legacy upgrade.

Signed email replies use the existing owner/recipient helper and actual payload header. Default copy is conservative when the reply channel is unavailable, while manager prose remains intact. The editable client email/inbox preview is intentionally conservative even when SMS is selected; it is not an SMS-delivery preview. SMS uses its own explicit YES/alternate-time body. Accepted/queued/provider-submitted outcomes remain distinguishable from handset delivery. Existing duplicate-SID, terminal proposal, cancellation, generation and pending-YES-never-books behavior stays covered.

No new navigation, route, native shell, font/image, client fetch, polling loop or persistent client cache appears in the diff. Existing shared web/native rendering remains. Extra reads are scoped server authorization checks, with sequential legacy resolution to avoid concurrently materializing one shared grant. Their cost scales with the matching outstanding legacy inventory; this is not a bulk repair and should not be cached as permission. Lifecycle trace summaries retain ids/enums/statuses without recipient/body or free-form provider-error text. The unchanged generic trace exception wrapper is not a newly audited privacy subsystem.

## Independent validation and provenance

Ran the following command on the final source/test snapshot:

```bash
env PATH=/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin:$PATH NODE_OPTIONS=--max-old-space-size=4096 SMS_RUNTIME_ENABLED=0 SMS_OUTBOX_SCHEDULER_READY=0 npx vitest run tests/unit/tour-lifecycle-sms-provenance.test.ts tests/unit/tour-reschedule-sms-reply.test.ts tests/unit/tour-guest-sms-consent.test.ts tests/unit/prp-473-tour-sms-eligibility.test.ts tests/unit/sms-conversation-log-dispatch.test.ts tests/unit/tour-notifications.test.ts tests/unit/tools/tours.test.ts tests/unit/inbound-email-reply.test.ts tests/unit/email-reply-address.test.ts tests/unit/inbound-email-webhook.test.ts --maxWorkers=1
```

Exit 0: 10 files, 189 tests, 11.60 seconds, including the final 54 reply tests. `git diff --check` independently exited 0. No broad compiler suite was duplicated.

Bugbot independently replayed the retained actual-module adversarial harness with the real active-tour helper, distinct future windows/properties, matching canonical conversation keys and fixed-behavior assertions. Exit 0 on Node22: all five final-read field mutations reached contested read 6, returned stale, performed one repair write, preserved the competitor and spent no SID; two legacy plus one modern returned ambiguous with zero writes. Root independently obtained the same results before review. These are hermetic persistence/provider boundaries, not live provider claims.

Sol's handoff reports full unit exit 0, 1,367 files / 9,483 tests; affected 189 and integration 11 tests exit 0; TypeScript, lint and build exit 0, with 726 existing lint warnings and 385 pages generated. These broad results are attributed to execution, not rerun by this reviewer. The final source was stable during full unit; one later test-only strengthening was followed by focused and TypeScript reruns. The independent 189-test run above includes that strengthening. Graph maintenance attempts remain honestly blocked by the installed CLI/repository command mismatch; no current pooled graph or incompatible sidecar was generated.

Verified fingerprints:

- Tracked `git diff -- src tests` SHA-256: `ec14da208214468d0e3429a99ce619e679f8941b7f5b94c5c3a8f68b0e318a95`.
- Reply module: `a75cd1caf2d02bf6a4da3ba61353240fd0f765b63d64bf5e14d9ebcc9a1ecbe5`.
- Reply tests: `6d910219dc8ef3007f90f4924c7f80ac7a4e0aa1e7ea633e1cf3246acca54ad1`.
- Untracked resolver: `c25a5c5c5ea6cd3c700b85b4b53107716591346bf75121ea3d016249dfed1746`.
- Untracked eligibility test: `29cbf01cec861a4faa2e8801340a6a1a7a57bf2152a39924bd299fa4db6d021c`.
- Untracked lifecycle test: `d57005e007208f2a9a473b26e2c855df9df9acab6efc0c8c2a28cfb28098b2b5`.

## Browser evidence and release limits

Independently viewed `output/playwright/prp473-resumed-desktop-preview.png`, `prp473-resumed-mobile-preview.png` and `prp473-resumed-resident-inbox.png`. The desktop/mobile preview shows the correct task property and corresponding Pacific window, truthful account/contact fallback, wrapped message text and reachable submit control. The resident screenshot shows the actual manager conversation and the persisted message with a reply composer. This reviewer did not repeat a cloud mutation or claim a fresh live browser interaction.

Sol drove the real manager route and reports HTTP200 with `guestNotification.inbox.sent:true`, sandbox email skip and SMS not requested; the same-time repeat returned HTTP400 without another lifecycle notification. Root's separate exact-host dev-only read confirms event `80eb0801-755d-4cf8-be15-bff69eafb61c`, Sep17 `16:00Z` to `17:00Z`, generation `46a97330-3f8f-4e4f-a8ba-cd2cd2a68cdd`, and exactly one message `tour:80eb0801-755d-4cf8-be15-bff69eafb61c:rescheduled:46a97330-3f8f-4e4f-a8ba-cd2cd2a68cdd` in resident thread `msg_inbox_1788671403204_8yxw`. That durable evidence closes the prior inbox gap. The screenshots and attributed route/read results are sufficient connected-path evidence for the unchanged UI plus this reply-state correction; they do not establish handset delivery.

Production remains gated. Remote main/production are newer at `2d1353af42c3a652be6cf8a69640468b453f4cea`, with relevant communication dependencies changed; this keeper has not been integrated or validated against that source. Remote staging is absent and `ship:preflight` remains reported exit 1. Captain integration, restored staging and staging QA, actual handset receipts/YES/STOP/START/alternate-time acceptance, actual email-provider routing, and eventual deployment/TestFlight checks remain separate. A green unit suite or keeper review cannot waive them. Agents must not merge protected branches or bypass staging.

Review URL: `http://localhost:3008/portal/tours/upcoming`.
