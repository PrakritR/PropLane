# Messaging failure investigation — 2026-09-05

Point-in-time investigation, not a standing defect checklist. Production was read only; no messages were sent, retried, or replayed. Changes below are local and have not been deployed.

## What “Could not send reply” actually meant

A confirmed bug affects manager and resident Communication replies sent through PropLane. The send handlers tracked `proplaneOk` and persisted the reply after success, but omitted it from the outcome returned to the toast. The toast recognized only email/SMS. A successful PropLane-only send therefore cleared the draft, saved the bubble, and displayed “Could not send reply.”

The toast by itself is not delivery evidence. The intended paths are:

| Conversation / channel | Destination | What acceptance establishes |
| --- | --- | --- |
| PropLane Assistant | Owner-scoped bot thread; returns before human-recipient fan-out | User turn saved; model response runs asynchronously |
| Person + PropLane | Authorized counterparty's portal inbox | In-app persistence; not an email or SMS receipt |
| Email | Email provider, with optional portal copies | Provider acceptance differs from delivery to the mailbox |
| SMS | Owner-scoped SMS outbox and provider | Queued, submitted, delivered, and unknown are different states |

Recent production records contain both a manager's user turn followed by a bot response and a resident's user turn followed by a bot response (September 5 UTC). This verifies that the bot path works in production; it does not identify the user's particular toast without a matching account/time.

## Fixes in this patch

1. **PropLane outcomes are retained end to end.** Manager and resident replies pass PropLane requested/accepted flags into the shared toast helper. Resident no longer maintains a divergent two-channel copy. Mixed success describes which channels succeeded or failed; unknown SMS retains the no-resend guidance.
2. **Accepted in-app replies survive notification failure.** Resident rollback now checks PropLane success too. An email failure after a successful in-app send cannot withdraw that message or falsely report total failure.
3. **Escalations cannot disable bot routing.** `notifyManagerFromAgent` previously changed the canonical assistant thread's type to `leasing_sms_escalation` / `vendor_agent_escalation`. The reply route only recognized `agent_notice`, so the next bot reply fell through to human-recipient validation. The conversation now retains `agent_notice`; the notification subtype lives on its message. Resolution recognizes existing affected canonical rows by exact owner-derived ID plus manager scope, after authorization, without rewriting production data.
4. **Manager bot approval requests are actually saved.** The runner previously told the manager to approve on the dashboard but discarded the proposal. It now persists the owner-scoped manager action with the server-generated proposal trace and only promises approval when that write succeeds. Inline write execution remains disabled.
5. **Manager prompts are no longer duplicated.** The route already saved the incoming turn before the runner reloaded history. The runner now avoids appending that final turn twice while retaining earlier intentional repetitions.
6. **Reply persistence is acknowledged honestly.** `commitInboxThreadReply` now rejects failed reads, missing threads, and rejected upserts. It cannot return success for an unsaved bot/user reply. Errors shown to the user are fixed copy; underlying database errors remain error causes.
7. **Manager bot outcome instrumentation.** Reuses `assistant_message_sent` / `assistant_action_proposed`; failed reply generation/persistence emits `assistant_reply_failed` with portal, surface, and a fixed reason enum, without message content or contact details. Existing Langfuse prompt/session tracing remains intact, and proposals retain their trace for approval scoring.

## Production evidence and limits

Window: approximately August 29–September 5, 2026, seven days ending during this investigation.

- **Supabase production** (`qahnczmilgptcedaqype`): 125 recently updated inbox threads inspected (bounded query, limit 300). Includes 10 `agent_notice` and 10 `resident_agent` rows. Most assistant rows are introductions/notices, so thread counts are not attempted-send counts.
- **SMS outbox:** 41 records: 38 `delivered`, one `unknown`, two `deferred`. The delivery-callback log independently contained 38 `delivered` records and no failed status in this window.
- **Unknown SMS:** a `manager_conversation` from August 31 has `provider_submission_outcome_unknown`, with no locally recorded provider status. This is not proof of rejection; automatic resend remains unsafe. The sender-number mapping is also absent now. A read-only Twilio lookup for that recipient/day returned one candidate, but none matched the exact body within ten minutes of the outbox timestamp. This bounded negative result cannot prove rejection and does not justify a resend.
- **Deferred SMS:** `tour_confirmed` and `tour_request_received`, created September 5 around 08:00 UTC, carry `control_plane_unreadable` and were due again around 08:05 UTC. These are not quiet-hour deferrals. A follow-up read reproduced the dispatcher checks: runtime configuration exists in `automatic` mode, neither number query failed, but both sender lookups returned no `manager_sms_numbers` row. The refusal is correct; sender identity/number setup needs to be resolved before these texts can send. No number was purchased or provisioned here.
- **Email visibility gap:** the live `portal_outbound_mail_records` table lacks the `channel` column used by current logging writes. Querying it returned SQL error `42703`; the existing migration is `20260522020000_outbound_mail_channel.sql`. A fallback read of existing columns found no mail records created in the window. Logging failures are currently ignored, so absence of a mail log is not evidence that an email was never sent. The migration needs the normal staging/production process; it was not applied here.
- **Langfuse:** scanned 360 observations in the seven-day window. They mix `production`, `default`, and `development`; do not combine them into a production failure rate. Two failed `escalate_to_manager` calls, both tagged `default`, returned `t?.phone?.trim is not a function`. Current notification routing already normalizes profile phones with `String(...)`; this patch adds a numeric-phone regression case, not a speculative duplicate fix. Three rejected `schedule_message` previews are also tagged `default`; the inspected preview correctly refused a send time in the past. No successful-summary turn reached the iteration limit (84 summaries across environments; 35 production-tagged).
- **Vercel:** the bounded production request-log query returned no rows, so there is no request-level correlation to the exact reported toast. This must not be described as “no request failures.”

## Additional gaps still requiring work

These are source-confirmed paths, not claims that each occurred in the production window:

- Resident assistant threads can silently decline when their stored manager binding is missing/stale. Reuse authenticated resident context/current relationships rather than bypassing the relationship check or guessing a manager.
- Resident inbox proposals are persisted but have no reachable resident approval card/archive association. Wire safe action ID/preview into the existing resident confirmation transport; do not execute writes directly.
- Resident inbox currently uses the unfiltered catalog instead of `buildResidentRegistry(ctx)` and therefore misses the normal phase/tier filtering.
- Email/SMS-only requests can return `ok:true` even when a provider leg did not succeed. The route needs explicit per-channel outcomes; preserve actual portal acceptance when optional notifications fail.
- Replies to stored `folder:"sent"` rows can append the same sender-side turn twice (initial commit plus Sent-copy delivery). Use one message identity across both writes. This is a duplicate stored turn, not proof of duplicate external delivery.
- Other delivery helpers still ignore database errors, and read/modify/upsert transcript writers can lose concurrent turns. These need a coordinated persistence/idempotency change rather than an automatic retry of an ambiguous send.

## Validation

- Full unit run: 1,124 suites / 7,427 tests passed; one six-test suite was blocked because the sandbox denied its localhost mock server (`listen EPERM`). Rerunning that exact suite outside the sandbox passed all six tests.
- Final focused regression run after all edits: 52 tests passed across eight suites (toast outcomes, manager/resident reply integrity, bot proposals/history, persistence failures, notice routing, numeric phone handling).
- Focused lint: no errors; existing unused-import/hook-dependency warnings in the large inbox panels remain.
- Type check: three errors in the pre-existing, untracked `output/assistant-redesign/implementation/entry.tsx`, all missing `managerName`; none in this patch's files.
- Read-only security/bug review: no blockers in the scoped patch. Auth checks, portal-bound approvals, no-inline-write rules, and unknown-SMS no-retry behavior remain intact.
- No navigation, deep-link, native-shell, layout, or caching changes. WebView clients receive these shared code fixes after the usual deployment.
- `ship:preflight` cannot authorize promotion from this dirty shared branch: local `origin/staging` and `origin/production` refs are missing. Shell-env warnings are not proof that production secrets are unset.
- Required `npx graphify hook-rebuild` was attempted; after registry access succeeded, npm reported no executable for that package. Graph refresh remains unavailable through the prescribed command.

No production deployment, database migration, number provisioning, outbound message, or manual resend was performed.
