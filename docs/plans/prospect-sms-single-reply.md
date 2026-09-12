# Prospect SMS: one reply per burst, grounded retrieval, GPT shadow

Approved by Akhil on 2026-09-12: implement the plan. Duplicate texts are the highest priority.
Starting branch: `prospect-agent-eval-loop`. Starting HEAD: `6f24d93b712f140d16af5f10e14b1fd88edd61aa`.
The tree already contains substantial unrelated and prospect evaluation work. Preserve it; do not commit others' changes.

## Decisions and incident evidence

- Twenty seconds of quiet after the latest prospect inbound, across direct Twilio and gateway ingress.
- Managed delayed queue (QStash), durable database state, one worker per conversation, stale-turn suppression.
- Stay silent on redundant repeated questions/acknowledgments. Default repeat window two minutes. Answer corrections, new facts, explicit repeat/clarification requests and changed availability.
- Claude remains customer-facing. GPT shadow only, initially configurable `gpt-5.4-mini`. Separate dev/prod OpenAI credentials will be supplied. Do not assume the existing local key is approved for live paid testing.
- No production release authorized. Production reads only, no production data writes or messages. Nonproduction real-data QA and Review URL are required; blocked external configuration must be reported honestly.
- Langfuse and Twilio were read using credentials in `.env`, NOT `.env.local`. Do not print credentials or raw PII. Vercel production env pull returned empty values. `.env` Supabase listing read returned no incident listing; do not assume it is the production DB.
- Langfuse session `23fd333e-0f22-46da-b73e-05291379423b`: traces `a79e51d7-80e5-4d31-9d5c-216607e24211` (04:22:43 UTC) and `ce993c3e-52be-40ee-975e-3d55753dde30` (04:22:45 UTC) overlap. Second input includes both Jain Home messages while first is still running. Twilio delivered duplicate descriptions at 04:22:53 and 04:23:01 on Sep 12.
- Same session traces `30ba9b93-10e3-4b97-a2d6-6f467ef8682b` and `11e59cd6-40ad-4626-9b02-924e58f94b18` overlap on tour corrections. Twilio delivered repeated follow-up answers at 04:33:48 and 04:33:52.
- Trace `0bda2419-71b3-4efe-976c-eb5473572599`: list_live_listings query JainHome returns count 0. Spaced query returns canonical property ID `mgr-jain-home-new-listing-p9r2z5uhb6vq`.
- Trace `ed8a54f1-896a-4072-b0bf-cba544b4aeca`: tour tool uses invented `6VFM7PaTVEKP7UR6JZWL` and returns empty slots; links fail listing_not_found; escalation fails delivery. Later tour tool uses invented `jain-home`; escalation dedupe falsely claims prior success.
- runLeasingSmsAgentTurn reloads only role/content and loses tool-returned canonical IDs. It persists assistant text before SMS submission. Two distinct inbound SIDs get distinct outbox dedupe keys, so no burst coordination exists. Gateway alone buffers 150s; direct Twilio bypasses it. Loop substitutes fallback text for an empty response.

## Implementation

### Priority 1: durable single-reply transport

Persist ingress and burst revisions in database, scoped to existing canonical conversation identity (owner, role, counterparty; preserve channel distinctions). Atomically claim source messages so duplicate webhooks do not generate twice. Use QStash delayed callbacks with opaque job IDs only, signature checks, and server-derived identities. Every inbound resets due time to latest +20s. Remove duplicate gateway delay only when shared scheduler is enabled; keep manager/STOP behavior intact.

Use leases and revision fencing for one worker per conversation. Snapshot consumed inbound IDs/history. New input during generation invalidates the candidate; process complete burst after quiet. Fence inline writes as well as final dispatch, reusing the existing typed tool/write framework. One durable outbox intent/dedupe key per burst. Recheck consent, takeover, revision before dispatch. Existing unknown Twilio submission outcomes stay terminal without blind retries. Webhook publish failures must remain recoverable; retry scheduling even for already persisted inbound; add monitored periodic queue-publication/expired-lease recovery.

Queue configuration is environment-specific. Implement fail-closed runtime gating and health checks; never silently switch enabled queue traffic back to immediate replies if configuration or scheduling fails. Use additive migrations, service-only mutations, account-purge classification and RLS coverage.

### Reply awareness and suppression

Build ordered history from actual submitted/delivered reply state, not merely generated candidates. Include canonical listing/room context, recent tool evidence, and timestamps. Add typed explicit suppression to the leasing SMS surface; preserve other surfaces' existing behavior. Suppression references a recent outbound message and reason. Do not use text equality alone for semantic repeats. Never suppress corrections/new questions/explicit resend requests simply for shared words. Suppressed candidates stay out of delivered history, but remain traceable. Failed/unknown delivery is not proof someone received an answer.

Fix escalation idempotency: audit claim is not notification success. A failed notification must not later yield alreadyEscalated success; preserve safe unknown-delivery behavior and existing outbox deduplication.

### Retrieval

Shared deterministic normalization for joined/spaced names, case, Unicode, punctuation; rank exact identity before existing fuzzy marketing tokens. Use shared resolver for listing query/routing, clarify ambiguous matches. No vector database needed for the observed defect.

Persist and pass canonical listing/room IDs from tool results; re-resolve explicit property changes. Tour tools must distinguish unresolved/nonpublic property, lookup failure, and checked property with zero slots without exposing private properties. Preserve public route compatibility. Keep listOpenTourSlots as only availability source, and approval-first request_tour. Check times before collecting contact details. Use server-formatted Pacific labels/current date, not model arithmetic. Recheck live availability at write time.

### GPT shadow and evaluation

Extend existing src/lib/agent/provider.ts and model/provider types with direct OpenAI Responses API adapter using existing tool schemas, validation and loop. Preserve function call IDs/results and any provider continuation state. Use store:false. Provider-specific availability checks replace blanket Anthropic-key assumptions where relevant.

For each eligible completed burst, asynchronously compare GPT using frozen conversation and recorded tool evidence. Shadow MUST NOT access live write/notification handlers, mutate production conversation state, or send anything. Missing fixture evidence is unknown. Reuse sealed prospect-eval tooling where safe. Tag paired Langfuse traces by burst, prompt hash/release, model/provider, shadow role, grounding/repetition, tool correctness, latency and usage. Exceptions or disabled/missing key never delay primary reply. Explicit environment activation and bounded concurrency/token/time limits.

Add provider comparison separate from same-model prompt comparison. Fix existing incomplete-baseline-repetition comparison defect described in docs/prospect-agent-evaluation.md before trusting results.

## Test matrix and acceptance

- Behavioral unit/integration: the two incident sequences, 20s reset, duplicate source SID, duplicate queue callback, two workers, new inbound during generation and before dispatch, stale inline writes, process restart/lease recovery, queue publish failure, accepted Twilio then timeout, consent/STOP/takeover, two people/roles/owners isolated.
- Every completed burst yields at most one outbound intent and submission. No stale reply; no duplicate inline action. Queue outage does not produce immediate double replies or silently lose the durable job.
- Semantic repetition vs legitimate correction/new detail/explicit repeat; no fallback text for explicit silence; failed sends excluded from answered memory.
- Joined JainHome/Jain Home, ambiguous matching, fabricated IDs, canonical ID continuity, public/private scoping, true empty calendar, lookup error, timezone/day labels, public-grid parity and approval-first writes.
- Escalation failure followed by retry cannot claim prior success.
- OpenAI adapter call/result round-trip, malformed arguments, timeouts, missing key, tool security and continuation. Shadow isolation proves zero Twilio/Supabase/notification writes and no primary latency dependency. Incomplete comparisons cannot pass.
- Seed nonproduction data and run end-user browser + designated test-recipient messaging QA where configured. Never write locked live listings or use /demo as evidence. Read relevant Next installed docs before route edits.
- Narrow tests first, then required normal tests/lint/typecheck/build; exact exit codes. No no-mistakes, no Linear, no PR unless requested. Refresh graphify and check portability before proposing graph artifacts.

## Execution and review

Fresh Sol-medium manager delegates Terra/Luna with explicit non-overlapping scopes, integrates and verifies. Save handoff under docs/plans/prospect-sms-single-reply-handoff.md with changed files, migrations, exact verification, remaining external prerequisites, browser Review URL. Root Astra then launches fresh Astra review; at most two correction cycles. Do not claim complete QA/deployment without evidence.

References: https://upstash.com/docs/qstash/api-reference/messages/publish-a-message ; https://developers.openai.com/api/docs/guides/function-calling ; https://developers.openai.com/api/docs/models/gpt-5.4-mini .

## Reviewed architecture amendment

The historical Claw rail was discovered to be deliberately retired in the authoritative SMS architecture. Its earlier dual-rail assumptions are superseded by `docs/plans/prospect-sms-retired-transport-amendment.md`: preserve retirement, implement and validate the active manager-owned Twilio path, and reject unsupported rails without sender fallback. This does not authorize reactivation or a production release.
