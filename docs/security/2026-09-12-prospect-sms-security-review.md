# Prospect SMS single-reply security review

Date: 2026-09-12. Independent read-only implementation review for Akhil.

Verdict: **changes required before activation**. One confirmed queue-integrity defect can strand a valid reply permanently. No new unauthenticated database-write or cross-tenant disclosure path was established in the reviewed change. External messaging and staging QA remain incomplete.

## Snapshot and boundaries

- Branch: `prospect-agent-eval-loop`; HEAD: `6f24d93b712f140d16af5f10e14b1fd88edd61aa`.
- Reviewed the uncommitted plan-scoped implementation described in `docs/plans/prospect-sms-single-reply.md` and its execution handoff. Unrelated pre-existing dirty workflow, release, Linear, and evaluation work was excluded.
- Migration SHA-256: `587d23a9770826c35a05f8cd6d3f3fdcabb2b92aec30b1b4ff8399914b09d710`.
- Read root/developer instructions, SMS architecture, relevant AI tool/security documentation, handoff, and independent database-probe evidence. Graphify query supplied orientation; current source and diff determined findings.
- Reviewed callback/cron authentication, durable ingress/claim/completion and inline-action RPCs, outbox preparation/submission, consent and pause gates, prospect history/tool scoping, escalation deduplication, shadow/provider isolation, and account-purge classification.
- No implementation edits, shared database actions, external messages, paid model calls, release, PR, or no-mistakes execution. This report is the only repository file authored by this reviewer.

## Finding SEC-1: P1 - Outbox publication before preparation can permanently strand a burst

Locations: `src/lib/sms/owner-sms-dispatcher.server.ts:207`, `src/lib/sms/owner-sms-dispatcher.server.ts:225`, `src/lib/sms/owner-sms-dispatcher.server.ts:255`; `supabase/migrations/20260912143000_prospect_sms_bursts.sql:202`, `supabase/migrations/20260912143000_prospect_sms_bursts.sql:243`.

`enqueueOwnerSms` inserts the prospect reply as an immediately eligible `queued` row, then calls the separate preparation RPC. A concurrent outbox dispatcher can claim the row before preparation. The submission RPC observes the burst still in `generating`, classifies the candidate as stale, and permanently changes the outbox to `blocked`. Preparation subsequently accepts that blocked outbox because it checks correlation fields without checking its status, leaving the burst `prepared` and the outbox `blocked`. Recovery scans only queued/expired-generating bursts; the blocked outbox is not retried. The customer receives no reply even though no provider submission was attempted.

Root Astra independently reproduced the precise interleaving against the reviewed migration in isolated PostgreSQL: `premature_cron_begin = stale`, `prepare_after_cron = true`, final state `prepared/blocked`; probe exited 0 without provider activity. See the appended evidence in `docs/plans/prospect-sms-db-probe.md`.

Required correction: make candidate insertion and burst preparation atomic, or keep the row unclaimable until preparation commits. Preparation and lease recovery must also handle a crash between insertion and attachment without allowing a blocked/submitted row to be revived. Add interleaving and crash-recovery tests at the SQL/runtime boundary; rerun the migration probe after correction.

## Security controls verified

- Callback authentication requires configured QStash signing keys and a constant-time comparison of the separate forwarded callback secret before the service-role database client is created. The installed Receiver verifies signature, issuer, expiry, body digest, and exact callback URL. Database revision/lease checks provide application-level replay protection in addition to JWT expiry.
- Callback payloads carry only an opaque burst ID/revision. Manager, recipient, body, and claimed source IDs come from service-only rows. Unknown/busy claims fail closed; obsolete revisions do not regenerate.
- New transcript, inline-action, and shadow tables enable RLS and revoke anon/authenticated privileges. All seven security-definer mutation RPCs pin the search path, revoke execution from PUBLIC/anon/authenticated, and grant execution to service_role. Root's isolated PostgreSQL probe verifies client-role denials and concurrent claim/submit winners; this is not a claim about deployed Supabase grants.
- New ingress preserves a live generation lease while changing the revision. Inline actions require a current revision/lease and a unique per-revision claim; only explicit known no-side-effect outcomes release it. Typed schemas and the leasing surface's existing two-write allowlist remain the execution boundary.
- Prospect history scopes inbound/outbound rows by owner and canonical conversation key, loads only current submitted/sent/delivered outbound states, and excludes the claimed source IDs before appending the claimed inbound text. Failed/unknown output is not accepted as prior answered text.
- Missing and nonpublic tour targets share the public `unavailable` outcome. Tour writes still check published live availability. Existing owner-scoped listing lookups and the public-catalog projection remain the prospect retrieval boundaries; this review did not broaden their authority.
- Dispatcher still derives the sender from registered owner-number state and checks runtime, entitlement, suppression, purpose/conversation consent, and budget. A disabled durable feature defers prepared prospect rows without provider calls. Submission uncertainty remains terminal `unknown`, preventing blind duplicate retries.
- The GPT shadow runner receives frozen conversation/schema/evidence values and imports no live registry, database, Twilio, or notification handlers. Tool requests must match recorded name and arguments. Actual model requests use a fixed OpenAI endpoint, `store:false`, bounded output/time, and explicit shadow activation plus an API key. Shadow jobs and output metadata remain service-only and are covered by account deletion.

## Validation performed by this reviewer

- Synthetic-key test against the installed `@upstash/qstash` Receiver: **exit 0, 6 assertions**. Valid signature accepted; tampered body, wrong callback URL, expired token, wrong issuer, and corrupt signature rejected. No network or real credential used. This supplements callback tests that mock Receiver; it does not prove deployed reverse-proxy URL handling or key rotation.
- `npx vitest run tests/unit/prospect-sms-burst-callback.test.ts tests/unit/prospect-sms-outbox-dispatch.test.ts tests/unit/prospect-sms-shadow-recovery.test.ts tests/unit/agent/openai-shadow-provider.test.ts tests/unit/leasing-sms-escalation.test.ts`: **exit 0, 5 files, 21 tests passed**.
- Migration hash and HEAD were independently checked. Full lint/build/unit results are owned by the implementation handoff; this review does not relabel them as independently executed checks.

## Remaining acceptance and external QA limits

- Consent is re-read during dispatch, but the existing dispatcher checks it before later database round trips and ultimately calls `sendSms(..., { skipOptOutCheck: true })` at `src/lib/sms/owner-sms-dispatcher.server.ts:565`. A concurrent STOP in that interval is an existing last-check-to-send race, not a newly demonstrated privilege escalation. The new revision RPC does not make consent updates and provider submission atomic. Drive STOP-before-generation, STOP-before-deferred-dispatch, and controlled STOP/send interleavings before activation; do not claim atomic STOP handling from the burst fence alone.
- The approved plan calls for takeover checks. No authoritative takeover switch or corresponding dispatch check was identified in the inspected prospect runtime. `agent_sessions.status = escalated` records notification state; the reviewed code does not establish that it represents a manager takeover. Treat takeover acceptance as unverified until the intended product state and behavior are specified and exercised. Do not claim a proven takeover bypass without identifying that authoritative state.
- Claw is documented as retired in the authoritative SMS notes, but the plan includes gateway behavior. Its in-memory receipt retry and changed cross-catalog routing are tracked with the parallel overall reviewer; gateway acceptance must state whether this is a supported transport. The Twilio service-only queue evidence does not establish Claw end-to-end behavior.
- No real managed QStash publication/callback/recovery cycle, Twilio acceptance/delivery, designated-recipient SMS QA, shared staging migration/preview QA, or paid GPT shadow execution was performed. The inherited OpenAI key was not used. Environment-specific credential separation remains an operator configuration requirement.
- Security conclusions apply to this exact snapshot. SEC-1 and any correction need a follow-up review and updated validation before the security gate can pass.
