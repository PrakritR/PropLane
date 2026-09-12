# Prospect conversation first production release

Date: 2026-09-11. Owner: Akhil. Astra planning phase.

User explicitly requested a production release: "can we get some form of
improvements to prod so that we can test it. take it straight to prod".
This authorizes the keeper -> main -> staging -> production ladder without
another approval question. It does not waive required staging QA, production
data locks, or fast-forward rules. No no-mistakes, Linear, Lavish, or PR.

## Workspace and baseline

Original workspace `/Users/akhilvemuri/coding/AXIS-2` is dirty with the preceding
evaluation feature and unrelated user changes. Do not stage, clean, or ship those
files. The evaluator still has a documented comparison blocker and is not a
release dependency.

Use leased pool checkout `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/4/AXIS-2`.
It is clean and detached at current origin/main and origin/staging:
`8ce3868b4e5775661956c6c3f36fcb146bfa931a`. Create keeper
`prospect-conversation-production` there. Production is
`2d1353af42c3a652be6cf8a69640468b453f4cea` and is an ancestor. The staging baseline
has green Test and Vercel Deploy runs (34552913643 / 34552913754), but also
contains 141 changed files and five pending-in-git communication billing
migrations relative to production. Root must verify release readiness/schema
coverage before promotion; do not silently ship a migration-dependent baseline.
Do not apply production migrations or write production rows.

Read current source in this checkout: it has prepaid AI-turn reservation and
durable replay (`comms-billing/turn-result.server.ts`) absent in the old workspace.
Preserve these. Repo instructions and Akhil feature-cycle documents from the
original workspace remain applicable if the clean checkout lacks local copies.

## Concrete first-release behavior

Focus on conversation quality and a quiet, explicit handoff. Full multi-message
debouncing requires a durable transport change and is out of this first release.
Do not claim prompt edits enforce one response per inbound burst or launch a
follow-up scheduler. No unsolicited follow-up is introduced.

1. Update the assembled leasing prompt's source instructions:
   - Speak naturally as the leasing team; do not present a database search.
     Respect scoped vs cross-catalog ownership and never claim ownership of
     another manager's listing.
   - Answer the latest message using the conversation: retain selected room,
     location corrections, duration, move-in urgency, and already-sent links.
     Re-resolve facts when the prospect actually changes listing. Clarify
     UW/Seattle versus Bellevue rather than silently substituting locations.
   - One concise reply and at most one clear clarification question. Combine
     related missing information. Do not restart the greeting on every fragment.
   - Replace "always include a link" with relevant links only. Do not offer to
     send a link already sent; resend when requested or materially different.
   - A prospect ready to pay/reserve/move now is a high-intent lead, not an
     authenticated resident to redirect to rent payment. Ask one useful
     clarification if appropriate; persistent uncertainty or a manager-only
     exception requires escalation. No fabricated pricing/availability/terms,
     approval, reservation, or payment claims. Preserve current transit,
     short-stay/deposit, tour-request, and mixed-question grounding instructions.
2. Add a narrow opt-in quiet handoff to the existing typed
   `escalate_to_manager` tool (e.g. optional handoff mode, default normal reply).
   It is for high-intent uncertainty when there is no remaining useful grounded
   answer for the prospect. Ordinary mixed questions still receive their useful
   answer. This is not a new tool/catalog/notification path.
   The output may authorize quiet behavior only after the existing notifier
   confirms delivery. A thrown/failed/suppressed notification, audit-only
   duplicate, or outer tool transport success with `{ok:false}` is not delivery.
   Be conservative on existing audit dedupe: do not claim it proves delivery.
   Keep manager identity server-derived and updates actor/session scoped.
3. In `runLeasingSmsAgentTurn`, observe actual tool payload results while
   forwarding all existing Langfuse observer events. For SMS only, a confirmed
   quiet handoff returns an explicit disposition with empty reply, rather than
   null. Do not persist a fictional outbound assistant message. Preserve
   session/inbound ids and trace id and existing billing/replay semantics.
   Resolve effective empty reply before trace return so traces do not claim the
   generic fallback was sent. Voice and email keep their established reply paths.
4. `handleClawLeasingInbound` recognizes that disposition and returns handled,
   `replied:false`; it must not send a template fallback. Twilio receipt completion
   should succeed without an outbox, so retries do not rerun an already completed
   handoff. Do not confuse null (failure/unavailable -> existing fallback) with
   intentional silence. Do not add a permanent escalated-session pause without
   an existing resume UI. Inbound logging/manager visibility remains intact.

## Implementation ownership

Fresh Sol-medium manager coordinates Terra for runtime/tool/caller implementation
and behavioral tests, Luna for prompt/context cases and read-only regression
review. Keep disjoint writes; Sol integrates docs and checks. Likely code:
`src/lib/agent/leasing-sms-system-prompt.ts`,
`src/lib/agent/leasing-sms-agent.server.ts`,
`src/lib/tools/domains/leasing-sms.ts`, `src/lib/claw-leasing-bot.server.ts`.
Avoid changing the shared loop, Twilio API route, or schema unless a concrete
invariant makes it necessary; return a planning blocker for material scope drift.
Update the authoritative SMS/AI docs concisely and add a dated handoff/review.

## Acceptance and validation

- Reproduce prior behavior through runtime/handler tests: successful quiet tool
  produces no tenant delivery and no fallback; null still falls back; failed
  payload/audit-only duplicate/notifier suppression cannot trigger quiet success.
- Preserve inbound logging, trace callbacks, and durable paid-turn replay. A
  repeated receipt/result must not charge, notify, or send twice.
- Assert voice/email keep replies and mixed grounded questions are not silenced.
- Test tool scope and existing notifier call; no raw SQL, no new write surface,
  no external transport in automated tests. Manager/prospect fictional fixtures.
- Existing leasing agent, Twilio leasing/retry, communication credit replay,
  system prompt, custom-instruction, and trace tests; full unit/lint/typecheck and
  build on final branch. Use Node heap 4096 and bounded workers; run heavy checks
  sequentially (host previously hit 2GB default heap OOM).
- Bounded real model experiment against all-fixture handlers using current
  assembled prompt and real loop. Inspect at least context/link repetition,
  UW/Bellevue correction, high-intent handoff, ordinary grounded mixed question.
  No production DB/notification/SMS/email calls. Do not depend on the preceding
  unapproved comparison runner or claim statistical model improvement.
- Real non-production data QA of the applicable inbound/Communication path;
  never /demo as proof. Do not send SMS/email to real people. Pin sandbox port
  before server and record review URL. Root owns staging QA/release verification.
- Fresh Astra review plus separate mandatory security-review and bugbot records
  before landing. Maximum two correction cycles for this new feature.
- Required graph refresh is currently unsupported/no-op in this environment;
  attempt only a bounded supported hook once, record exact outcome, do not
  migrate/overwrite graph state or repeatedly hang npm.

## Release responsibilities

Root verifies pending staging baseline/migration coverage, performs normal
reviews/QA, runs ship:preflight, commits/pushes keeper and fast-forwards to main,
then staging, verifies exact staging deployment and scoped QA, then production.
Never force, never bypass staging, never run retired manual Vercel wrappers.
Verify Vercel Production plus TestFlight distribution; report actual missing
secrets or external blockers. Do not apply production data/schema writes to
make a release pass. If a dependency is blocked, finish the reviewable patch
and report the concrete release blocker.

Return a durable Sol handoff containing changed files, exact test exits, real
model/QA evidence, and unresolved risks. Do not commit/push/promote until root's
review and release checks are complete.
