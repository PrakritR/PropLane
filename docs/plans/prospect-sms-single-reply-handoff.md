# Prospect SMS single-reply execution handoff

## Goal and source

- Approved plan: `docs/plans/prospect-sms-single-reply.md`
- Branch: `prospect-agent-eval-loop`
- Starting and current commit: `6f24d93b712f140d16af5f10e14b1fd88edd61aa` (work is intentionally uncommitted pending fresh Astra review)
- Priority: prevent duplicate prospect replies while preserving grounded follow-up context.

## Implemented behavior

- Every supported manager-owned Twilio prospect receipt is durably recorded before acknowledgment and joins one owner + prospect phone + SMS conversation burst. The historical Claw/shared-line rail is retired and is rejected before durable acceptance. Duplicate source IDs do not reset the deadline. New fragments reset a 20-second quiet window.
- QStash publishes opaque burst/revision jobs, signs callbacks with Receiver JWT verification, and forwards a separate callback secret. The worker loads only its atomically claimed source IDs. Busy/transient callbacks return 503; obsolete callbacks return 200.
- A generation lease permits one worker. New inbound makes an older revision stale without permitting a second simultaneous generation. Inline request/escalation writes validate typed input first and use a once-per-revision database claim. Only explicit `retrySafe: true, sideEffects: "none"` outcomes release that claim; success and unknown errors remain claimed.
- Generated replies enter one prepared outbox intent. Dispatch's transaction locks the prepared burst and outbox, spends through the existing budget RPC, then changes the outbox to `submitting`. This is the linearization point: inbound committed before it invalidates the candidate; inbound after it belongs to the next burst. The database and Twilio HTTP request are not claimed to be atomic. Provider submission uncertainty remains terminal `unknown`.
- Disabling `PROSPECT_SMS_BURSTS_ENABLED` rejects queued callbacks and defers already-prepared prospect outbox rows. Other SMS traffic retains its normal dispatch path.
- Queue publication and expired leases are recovered by `/api/cron/prospect-sms-bursts` every five minutes. Publishing has a five-second request timeout and a bounded 15-second sweep. Shadow recovery claims at most two jobs concurrently with fresh leases.
- Durable SMS history appends the exact claimed text once, excludes post-claim ingress, and takes assistant messages only from outbox rows whose current status is `submitted`, `sent`, or `delivered`. Candidate, failed, and unknown replies never become assistant history.
- Listing identity matching normalizes joined/spaced names, punctuation, case, and Unicode. Successful canonical listing/room tool evidence is timestamped, survives no-tool clarification turns, changes only after a new successful property lookup, and requires tour availability to be rechecked.
- Silence is a typed `suppress_redundant_reply` result tied to an actual recent submitted/sent/delivered outbox ID. Durable failures cannot fall through to keyword templates.
- Tour lookup presents one unavailable/unresolved public outcome for missing and nonpublic listings, while preserving lookup-error and checked-zero-slot semantics. The public route projection remains unchanged.
- Escalation writes an audit intent before notification, records delivered/failed outcome, does not infer success from legacy audit rows, and uses one notification idempotency key across inbox, push, and SMS paths.
- The OpenAI Responses adapter uses `store:false`, stateless opaque output replay, distinct response item/call IDs, strict object JSON arguments, provider timeouts, and the existing typed schemas. GPT shadow receives a frozen pre-turn conversation and exact sealed tool evidence with no handlers or incumbent answer.
- A shadow job is inserted atomically only when a reply crosses `submitting`. Deferred dispatches and callback crashes therefore remain eligible. The recovery cron claims and awaits jobs, stores completed/unknown metadata, and emits a Langfuse trace paired by burst and primary trace ID. Disabled or missing-key runs leave jobs pending.
- The existing prospect evaluation comparison now treats any incomplete deterministic repetition evidence as unknown, including mixed fail + unknown baselines.

## Migration and database evidence

- Migration: `supabase/migrations/20260912143000_prospect_sms_bursts.sql`
- It adds service-only burst, ingress, inline-action, and shadow-job tables; outbox correlation columns; RLS/privilege denial; ingress, claim, completion, inline authorization/release, prepare, and submit-boundary RPCs.
- Final isolated PostgreSQL evidence is recorded in `docs/plans/prospect-sms-db-probe.md`. The final migration snapshot hash is `587d23a9770826c35a05f8cd6d3f3fdcabb2b92aec30b1b4ff8399914b09d710`; clean apply and repeat apply exited 0; 52 concurrency/security/state assertions passed.
- The probe covers duplicate SID deadline stability, active Twilio owner/phone isolation, concurrent claims, stale worker release, handled watermark, single inline action and safe release authorization, prepare/defer/expired-lease retry, one submitting/budget winner, context promotion, new-input invalidation, terminal unknown, exact-one frozen shadow job, retired-rail rejection, and anon/auth denial.
- The feature migration was not pushed to shared staging. `docs/database-environments.md` requires staging schema changes from the staging release checkout, after authorization.

## Activation and rollback

Required durable queue variables:

- `PROSPECT_SMS_BURSTS_ENABLED=1`
- `QSTASH_URL`
- `QSTASH_TOKEN`
- `QSTASH_CURRENT_SIGNING_KEY`
- `QSTASH_NEXT_SIGNING_KEY`
- `PROSPECT_SMS_BURST_CALLBACK_URL` pointing to `/api/internal/prospect-sms-burst`
- `PROSPECT_SMS_BURST_CALLBACK_SECRET`
- `CRON_SECRET` for `/api/cron/prospect-sms-bursts`

Optional shadow variables:

- `AXIS_PROSPECT_GPT_SHADOW_ENABLED=true`
- a designated nonproduction `OPENAI_API_KEY`
- `AXIS_PROSPECT_GPT_SHADOW_MODEL` (default `gpt-5.4-mini`)
- `AXIS_PROSPECT_GPT_SHADOW_MAX_CONCURRENCY` (default 2)
- `AXIS_PROSPECT_GPT_SHADOW_TOTAL_TIMEOUT_MS` (default 10000, capped at 30000)
- `AXIS_PROSPECT_GPT_SHADOW_MAX_OUTPUT_TOKENS` (default 512)

Rollback is `PROSPECT_SMS_BURSTS_ENABLED=0`. Already-queued callbacks fail closed and already-prepared prospect outbox rows defer, so old automatic work cannot leak through after deactivation. Newly received supported Twilio ingress follows the existing legacy synchronous path; Claw ingress remains retired. No schema rollback or destructive cleanup is required.

## Validation evidence

- `git diff --check`: exit 0.
- `npx tsc --noEmit`: exit 0.
- Focused integrated SMS/provider/account suite: 8 files, 59 tests passed, exit 0.
- Follow-up account/history/recovery suite: 5 files, 53 tests passed, exit 0.
- `npx eslint <29 changed source/test files>`: exit 0.
- `npm run lint`: exit 0, 0 errors and 1001 pre-existing repository warnings.
- `npm run test:unit`: final rerun passed 1,330 files / 9,133 tests, exit 0. The first run found one missing QA delete-order classification; it was corrected before the green rerun.
- `npm run build`: the default 2 GB process compiled but later exhausted its heap. `NODE_OPTIONS=--max-old-space-size=4096 npm run build` completed successfully, exit 0, including TypeScript and all 387 static pages.
- `npx --yes npm@10.9.4 install --package-lock-only --ignore-scripts`: exit 0. This removed npm 11 peer-metadata churn; the final lock diff contains only QStash and its three transitive packages.
- `npm run lockfile:verify`: exit 0 (`npm ci OK`).
- `npm run test:seed`: command exit 0, but the fixture logged a Stripe 401 for the placeholder `sk_test_...` key, so this is not accepted as complete seeded feature QA.
- `npm run sandbox:pin -- 3010` and `npm run sandbox:open -- /portal/communication/sms`: exit 0. Review URL: `http://localhost:3010/portal/communication/sms` (development server started and reached Ready).
- `npx graphify hook-rebuild`: exit 1 because npm could not determine a graphify executable. `.graphify` was not refreshed.
- OpenAI shadow provider behavioral suite: 11 tests cover store:false call/result continuation, distinct IDs, malformed args, matching and wrong-property evidence, frozen pre-turn history, aggregate usage, refusal/incomplete output, and concurrency overflow.
- Durable callback tests cover fail-closed configuration, busy vs stale callback status, exact source loading, and suppression without enqueue. Dispatcher coverage proves a prepared prospect row is deferred with zero provider calls when disabled. Shadow recovery coverage proves disabled no-claim, pending completion, expired lease reclaim, claim-loser isolation, and a two-job cap.

## External QA limits

- No QStash credentials are present locally, so a real managed publish/callback/recovery cycle was not run.
- The inherited `OPENAI_API_KEY` was not used. No designated development OpenAI key was supplied, so no paid GPT shadow call was made.
- No designated SMS test recipient was supplied. No Twilio or Claw message was sent; historical recipients were not treated as authorization.
- Shared staging migration/preview QA awaits the normal release ladder. No production write, send, schema action, release, PR, Linear action, or no-mistakes run occurred.

## Dirty-tree boundary for review

The branch already contained substantial uncommitted evaluation/process work before this execution. Do not stage the whole tree. The SMS implementation owns the migration, `src/app/api/internal/prospect-sms-burst`, `src/app/api/cron/prospect-sms-bursts`, `src/lib/sms/prospect-sms-burst.server.ts`, SMS/agent/tool files named by the plan, `scripts/lib/account-deletion.mjs`, `vercel.json`, the new SMS/provider tests, and the QStash dependency lines. Existing workflow, Linear, release, broad evaluation artifacts, and unrelated docs were pre-existing dirty work unless a fresh diff review proves otherwise.

The initial dirty list captured before implementation included `.cursor/rules/*`, `.github/workflows/agent-regression.yml`, `AGENTS.md`, developer/deployment/ship documentation, Linear scripts/docs, `docs/observability.md`, `scripts/langfuse-run-agent-regression.mjs`, `scripts/ship-preflight.sh`, `tests/unit/agent-regression-gate.test.ts`, the prospect evaluation docs/evals/scripts/tests, and `package.json`/`package-lock.json`. In `package.json`, the task-owned change is the `@upstash/qstash` dependency only; the Linear setup and prospect-eval scripts pre-existed. In `package-lock.json`, the final task-owned diff is the root QStash dependency plus `@upstash/qstash`, `crypto-js`, `jose`, and `neverthrow` package entries.

## Fresh reviewer prompt

Read `AGENTS.md`, `docs/agents/AGENTS-akhil.md`, `docs/agents/akhil-feature-cycle.md`, `docs/plans/prospect-sms-single-reply.md`, this handoff, and `docs/plans/prospect-sms-db-probe.md`. Review the uncommitted plan-scoped diff from starting HEAD `6f24d93b712f140d16af5f10e14b1fd88edd61aa`, while treating the dirty-tree boundary above carefully. Verify duplicate prevention, authorization and RLS, callback/QStash authentication, exact claimed history, prepared/submit race semantics, fail-closed kill switch, terminal unknown behavior, durable shadow isolation/recovery, tour privacy, escalation idempotency, and package-lock integrity. Re-run risk-based tests. Do not write production/staging, send SMS, use the inherited OpenAI key, release, create a PR/Linear ticket, or run no-mistakes.
