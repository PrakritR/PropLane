# Communication credit integration review — September 10, 2026

## Reviewed scope

Security review and Bugbot reviewed `293137a29d1a54636552b64128707a0d607c159c`
plus the uncommitted campaign-budget correction: dispatcher, additive migration
`20260910190000_sms_outbox_campaign_budget.sql`, dispatcher retry test, PostgreSQL
integration test, and SMS architecture documentation. This head preserves the
previous no-mistakes fixes through `5f868306b` and merges the captain's listing
changes through `2d1353af` without conflicts.

## Findings and disposition

- Security review: no material findings. The new service-role-only RPC locks the
  outbox row and verifies status, worker identity, and actual lease expiry before
  reading the daily reservation marker. Campaign spending and the marker update
  commit atomically. A wait for a row lock cannot reuse an expired lease because
  expiry is compared with `clock_timestamp()`.
- Bugbot: the P2 repeat-spend defect is resolved. A failed credit read previously
  consumed campaign allowance on each five-minute retry. The corrected path
  allocates once per message/UTC day and preserves wallet reservation semantics.
  No new P1/P2 findings were reported.
- Both reviews confirmed that the listing merge preserves staff-only processing
  coverage; a subscription tier or shared code cannot grant coverage.

## Validation evidence

- Full merged Vitest run: **1,431 files / 9,847 tests passed**, 4 files / 36 tests
  skipped; exit 0. An initial new test-fixture lease-reset failure was corrected
  before this successful run.
- Dispatcher and real local PostgreSQL campaign tests: **12 passed**, exit 0.
  Covered concurrent and repeated reservations, shared-cap rejection without a
  marker, UTC rollover, stale claims after allocation, and client-role lockout.
- Production build and TypeScript: exit 0. Changed-file ESLint and
  `git diff --check`: exit 0.
- Prior no-mistakes run `01M26Q2DF5D2PH3SQWYNV9QT2S` completed review, test,
  documentation and lint at `5f868306b`: 106 targeted unit tests, 11 webhook
  tests, 11 real PostgreSQL wallet tests, and authenticated desktop/mobile
  billing verification passed. The campaign retry finding was carried forward
  from its documentation-only stage and is resolved by the correction above.
- Additive wallet snapshot and campaign migrations were applied only to the
  dev/test project after isolated migration-history dry runs. No production
  data, SMS sends, or paid live transactions were involved.

This records dated review and verification evidence. Product contracts remain
in the area documents; see the [feature QA record](../qa/communication-credit-2026-09-10.md)
for the earlier real Stripe test-mode purchase, refund, saved-card and browser flows.
