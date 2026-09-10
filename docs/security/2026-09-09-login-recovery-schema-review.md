# Login recovery schema compatibility

Reviewed base: `e83e3d0c524b80794697ca0d3d49efca61b25e98` (`origin/production`).
Review scope: the uncommitted changes to `account-recovery.server.ts` and
`account-recovery-schema-compatibility.test.ts` on `codex/login-recovery-outage`.

## Incident and fix

A read-only production request for an impossible user UUID returned HTTP 404,
`PGRST205`: `Could not find the table 'public.account_recovery_requests' in the schema cache`.
The auth continuation catches this exception and routes users to account recovery;
the recovery endpoint repeats the failing query and returns the reported 503 message.
The recovery feature handoff documents migrations applied to dev only.

The lookup now returns no pending recovery only for exact missing-table errors
for this relation (`PGRST205` / `42P01`). All other errors still throw. Deletion
requires the schema before subscription cancellation, relay changes or cleanup.
No production rows, schema, storage objects, or deployments were changed.

## Reviews

- Security-review: no demonstrated Critical/High findings. Verified deletion
  checks precede external effects and permission/column/network errors stay closed.
- Bugbot: no blocking findings; independently ran all 11 new regression tests.
- Cache/performance: no persistent caching or extra queries introduced; private
  no-store response headers remain intact.
- Web/native: both share the same server lookup and auth continuation; no route,
  navigation, native-shell or role authorization changes.

Medium rollout caveat: `PGRST205` establishes missing schema-cache visibility,
not physical table absence. The fallback also reaches identity reconciliation
and provisioning. The never-migrated-environment assumption is supported by the
feature handoff and production response, but was not independently verified with
SQL catalog access. Do not interpret unrelated schema-cache outages as evidence
that retained account data cannot exist. Complete the recovery migration ladder
and QA before enabling account deletion on production.

## Validation

- Targeted login/recovery tests: 4 files, 30 tests passed, exit 0.
- Changed-file ESLint: exit 0.
- Seed: initial attempt failed on a placeholder Stripe key; rerun using the
  existing real test-mode key completed with exit 0 against dev/test.
- Local authenticated recovery GET: HTTP 200, `{ "request": null }`.
- Real manager password sign-in advanced through `/auth/continue` to the
  `/portal/dashboard` navigation after refreshing the session following seeding.
- Read-only production verification of the transpiled lookup function from the
  changed source: ordinary lookup returned null; strict lookup still rejected
  the missing table, exit 0. Only the all-zero user UUID was queried.
- `git diff --check`: exit 0.
- Full unit suite and repository-wide TypeScript checks were attempted, then
  stopped during prolonged local resource contention (exit 143). They are not
  passes; rerun before promotion. No production build or staging QA was completed.
- Graph refresh unavailable: `npx graphify hook-rebuild` exits 1 (no executable);
  installed `graphify hook-rebuild` also exits 1 (unknown command).

Review URL: http://localhost:3011/auth/sign-in

The keeper requires captain integration and staging QA before production.
