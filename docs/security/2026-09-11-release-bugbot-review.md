# Production release bugbot regression review - 2026-09-11

## Review identity and scope

- Live/base: `2d1353af42c3a652be6cf8a69640468b453f4cea`.
- Current HEAD: `97815a2d459c0bf96e9e80d4f94d29bff7d23fe2`.
- Pending uncommitted merge to account for: `main` `8ce3868b4e5775661956c6c3f36fcb146bfa931a`.
- The local HEAD is the bounded communication-billing rollout commit with parent `dbb3836e36ec23abd347f16d3eb1b7df7270b015`; the requested pending merge is recorded above as supplied release context, not represented as a local merge commit.

Inspected the source and migration changes from the live base through the index and working tree, excluding `scripts/apply-20260911-comms-billing-migrations.mjs`, its test, and the separately changing untracked recovery migration. Focus areas were wallet reservation/settlement, campaign retry behavior, zero-credit paths, Stripe fulfillment/reversal, inbound and voice routing, tour lifecycle notification revocation before provider dispatch, cache/rendering headers, route redirects, and web/native parity. The required Akhil, ship-gate, communication-credit, tours, and web/native parity instructions were read, along with the installed Next route-handler and previous-model caching guidance.

## Findings

### P2 - A no-send exhausted-wallet race spends the shared campaign cap

File: [src/lib/sms/owner-sms-dispatcher.server.ts](/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/3/AXIS-2/src/lib/sms/owner-sms-dispatcher.server.ts:551)

The dispatcher calls `spend_sms_outbox_segment_budget` at lines 553-556 before `reserveCommsCredit` at lines 590-594. If the outbox was queued while funded but the manager's wallet is exhausted before dispatch, the campaign RPC atomically marks `campaign_budget_spent_on` and returns success; the wallet RPC then returns the definitive `allowance_exhausted` result. The row is changed to `blocked` at lines 617-622 and no provider call occurs, but the campaign segment allowance is not restored.

Repro:

1. Queue a one-segment outbox row while the manager has at least one segment of credit.
2. Consume the manager's remaining wallet credit through another send or a concurrent reservation before the worker handles that row.
3. Run `dispatchOwnerSmsOutbox` on the row. The campaign marker is written, wallet reservation returns `allowance_exhausted`, and the row becomes blocked without reaching Twilio.
4. Send another valid one-segment row the same UTC day. The shared campaign budget now includes the blocked message and can defer the valid message despite there having been no carrier submission.

This contradicts the effective “pre-provider” accounting expectation for a definitive wallet refusal and makes campaign retry/cap behavior dependent on a race that produced no billable send. The migration only makes campaign allocation and its per-outbox marker atomic with each other; it does not make campaign allocation conditional on successful wallet reservation.

## No finding recorded

I did not find a concrete routing/cache/rendering/native-parity regression in the inspected changed paths. Public tour availability remains explicitly `no-store`, authenticated billing responses remain private `no-store`, and the added communication-credit parity contract keeps Stripe top-ups web-only. Tour cancel/reschedule writes occur before notification work, and lifecycle SMS is revalidated again at the outbox/provider boundary, so a revocation between enqueue and dispatch is blocked before provider submission.

## Limitations and blockers

- Read-only review only. No application code, tests, or git state were modified.
- No builds, test suites, database connections, provider calls, browser runs, credentials, or remote operations were used. Therefore this report contains source-level findings only and no invented pass/fail results.
- The named untracked migration-apply script and its test were excluded as requested. The pending `main` merge was not materialized locally, so merge-only conflicts or behavior not present in the current index/working tree could not be assessed.
