# Prospect SMS release integration handoff

Date: 2026-09-12

## Scope and result

Integrated the manifest at `/tmp/prospect-sms-release-scope` into upstream `b6085cd66e18da232640b4bc57d05e4499eb71a3` on local branch `prospect-sms-release`. The original workspace was not changed. No commit, push, deployment, shared database write, message send, paid model call, PR, Linear action, or no-mistakes run occurred.

The merged runtime preserves current manager-owned Twilio routing, work-number owner and thread authorization, dispatch-time consent, communication credits, campaign budget, conversation-log repair, richer listing and transit facts, and delivered quiet manager handoff. It adds durable 20-second prospect bursts, revision and inline-write fencing, atomic outbox preparation, typed redundant-reply suppression, canonical listing continuity, sealed GPT shadow inputs, signed QStash callbacks, and recovery cron behavior. Claw remains retired.

The final atomic `begin_sms_outbox_submission(uuid,text,uuid,timestamptz,integer,integer,integer,text)` keeps the established BURST-to-OUTBOX lock order. It derives owner, quantity, and credit key from the locked outbox, reserves the communication credit and campaign budget in one transaction, seals history/shadow state, snapshots the provider sender, and marks the outbox submitting. Refusal rolls the transaction back. The dispatcher does not reserve that burst credit a second time; ordinary outbox rows retain the existing application reservation path.

Quiet manager handoff now returns `completedWithoutReply: "quiet_handoff"`. The signed callback records it as a terminal no-reply burst, so it cannot be failed and requeued forever. Typed suppression remains separately identified in the callback response.

Feature-off compatibility is fail closed and does not require the new schema on existing traffic: Twilio uses the legacy synchronous path when `PROSPECT_SMS_BURSTS_ENABLED` is not `1`; the new cron exits at its health gate before querying burst tables; ordinary claimed outbox rows have no burst id and retain the existing dispatcher path. Activation still requires schema first, all QStash/callback credentials, the signed callback, and recovery QA.

## Validation

- `npm ci`: exit 0.
- `npm run lockfile:verify`: exit 0, reported by the independent inventory delegate. `@upstash/qstash` is the only package addition and is locked at 2.11.3.
- `NODE_OPTIONS=--max-old-space-size=4096 npx tsc --noEmit --pretty false`: exit 0.
- `npm run lint`: exit 0, 0 errors and 719 existing repository warnings.
- Core agent/provider integration: 7 files, 72 tests passed, exit 0.
- Quiet handoff, suppression replay, billing replay, escalation, and real runtime boundary: 4 files, 52 tests passed, exit 0.
- Inbound retry and durable transport rerun after restoring upstream thrown-error propagation: 5 files, 27 tests passed, exit 0.
- Final blocker regressions: `npx vitest run tests/unit/prospect-sms-outbox-dispatch.test.ts tests/unit/prospect-sms-burst-callback.test.ts`: 2 files, 13 tests passed, exit 0. This includes a behavioral funded-burst submission proving one provider call and no second application credit reservation, plus terminal durable quiet handoff completion.
- Ordinary reservation regression: `npx vitest run tests/unit/sms-conversation-log-dispatch.test.ts -t "retains campaign and wallet dispatch for a currently authorized derived tour"`: 1 passed, 9 skipped, exit 0. It asserts the ordinary row still calls `reserveCommsCredit` and submits once.
- Leasing SMS registry isolation after its intentional ninth capability: `npx vitest run tests/unit/agent/portal-assistant-wiring.test.ts`: 23 tests passed, exit 0.
- Isolated PostgreSQL against actual current outbox, billing, wallet, and campaign DDL: clean apply exit 0, repeat apply exit 0, 97 assertions passed. Coverage includes credit refusal rollback, campaign rollback/recovery, funded same-outbox retry, owner/quantity binding, sender snapshot, stale-ingress fence, terminal unknown behavior, sealed shadow/history, and client-role RPC denial. Exact evidence is in `docs/plans/prospect-sms-db-probe.md`.
- `git diff --check`: exit 0 before the final two narrow test additions; rerun required after this handoff is staged.

Root owns the concurrently running full unit test and final 4 GB build, fresh integrated Astra/security review, browser QA, preflight, commit/push, schema promotion, and release ladder.

## Activation and remaining conditions

`PROSPECT_SMS_BURSTS_ENABLED` must stay off. QStash variables are absent from staging and production. Production does not yet have the burst migration, and the production data lock requires manual operator application. No designated development OpenAI key or SMS recipient was supplied, so no paid shadow comparison or real message was run.

The known FINAL-1/P2 shadow grounding scorer defect remains unchanged by explicit instruction. Positive grounding comparisons must not be treated as reliable until field/value relationships are corrected in a separately authorized cycle. No authoritative manager takeover state exists; escalation is notification state only.

Graph refresh remains unavailable in this checkout: no `.graphify/graph.json` is present, and the installed `npx graphify` package exposes no executable for `hook-rebuild` or `portable-check`. No graph artifact was rewritten.
