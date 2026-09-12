# SMS production activation prerequisite handoff

## Goal and scope

Execution handoff for `docs/plans/2026-09-12-sms-production-activation.md`.
This phase changed only the two bounded migration prerequisites: add-on purchase
writes are closed before billing or entitlement mutation, and workspace creation
uses one atomic database operation for the server-derived plan cap. Existing SMS
implementation was not changed.

## Repository state

- Checkout: `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/5/AXIS-2`
- Branch: `prospect-sms-release`
- Starting/current HEAD: `a4967b835880ad44b13b10c1fcc112de80081fbe`
- No commit or push was made. The plan file is present as an untracked artifact
  copied into this pool by the root session.

## Decisions and behavior

- `setManagerPlanAddonQuantity` preserves its empty-identity and invalid-quantity
  responses, then returns stable code `add_on_purchases_unavailable` before any
  plan, service-role, Stripe, or entitlement read/write. The unsafe mutation
  implementation and its Stripe dependencies were removed. There is no toggle
  that can reactivate it.
- The add-on catalog always reports `purchasable: false`. Existing quantities and
  plan-limit reads remain supported.
- `loadWorkspacePlan` marks the plan unknown when either the base plan or add-on
  quantity read fails. Create then returns 503 rather than treating unread add-ons
  as zero purchased capacity.
- `POST /api/workspaces` derives owner from the authenticated session and cap from
  `loadWorkspacePlan`, then calls
  `create_portal_workspace_with_limit(p_owner uuid,p_name text,p_limit integer)`.
  Client-supplied owner/cap fields are ignored. The courtesy precheck returns 403;
  a null atomic-RPC result after a concurrent last-slot loss returns 409.
- The RPC validates owner, name, and cap 1..10; uses `search_path = ''` and
  qualified objects/functions; acquires the same `workspace-owner:` transaction
  advisory-lock key as the existing trigger; creates/counts the default workspace
  under that lock; and inserts only below the passed cap. Execute is revoked from
  PUBLIC, anon, and authenticated and granted only to service_role.

## Changed files

- `src/lib/plan-addons.server.ts`
- `src/app/api/manager/plan-addons/route.ts`
- `src/lib/workspaces/server.ts`
- `src/app/api/workspaces/route.ts`
- `supabase/migrations/20260913001000_atomic_workspace_plan_limit.sql`
  - SHA-256: `0c1924b8a0e2339d6bb6ae370ff2823badb5374bde51f157b788ac09b3cfe36c`
- `tests/unit/manager-plan-addons-closure.test.ts`
- `tests/unit/workspace-plan-addons.test.ts`
- `tests/unit/workspaces-create-route-contract.test.ts`
- `tests/unit/atomic-workspace-plan-limit-migration.test.ts`
- `tests/integration/atomic-workspace-plan-limit-postgres.test.ts`

## Validation evidence

- `npx vitest run tests/unit/manager-plan-addons-closure.test.ts tests/unit/workspace-plan-addons.test.ts tests/unit/workspaces-create-route-contract.test.ts tests/unit/atomic-workspace-plan-limit-migration.test.ts`
  - exit 0; 4 files, 20 tests passed.
- `WORKSPACE_RPC_TEST_DATABASE_URL=postgresql://akhilvemuri@127.0.0.1:55441/axis_workspace_rpc_test npx vitest run tests/integration/atomic-workspace-plan-limit-postgres.test.ts`
  - exit 0; 1 file, 4 tests passed against a disposable local PostgreSQL cluster.
  - Verified service_role-only ACL, exactly one winner among 12 concurrent final-slot
    creates, default-workspace counting at cap 1, and SQL rejection of invalid
    caps/names. The cluster was stopped and removed afterward.
  - Root independently repeated the same suite on port 55439 with exit 0 and 4 tests.
- Scoped ESLint over all changed TypeScript/test files: exit 0.
- `npx tsc --noEmit --incremental false`: exit 0 in the Terra implementation run.
- `git diff --check`: exit 0.
- `npx graphify hook-rebuild`: Terra reported exit 0 after production-code edits.
  A later invocation after test-only edits did not return within its 30-second
  initial window, so root should verify Graphify state before committing.

No browser path was exercised in this phase because the change is a closed API
write boundary and database RPC. Root owns staging QA with real non-production
records after schema application.

## Review and rollout notes

- Review the new SQL independently alongside the two already reviewed pending
  migrations. Apply only the exact three files through the root's guarded path.
- Preserve the transition POST gates until deployed route behavior is verified.
- Confirm the target function signature and ACL exactly match the pinned name,
  then exercise concurrent final-slot creation on staging.
- Full unit/build, fresh Astra/security review, schema apply, staging QA, branch
  promotion, production verification, and transition-gate removal remain owned
  by the root session under the plan.

## Fresh reviewer prompt

Review `docs/plans/2026-09-12-sms-production-activation.md`, this handoff, and the
diff from HEAD `a4967b835880ad44b13b10c1fcc112de80081fbe`. Focus on whether every add-on
purchase context reaches zero Stripe/entitlement writes, whether unknown add-on
reads fail closed, whether the authenticated owner and server-resolved cap are
the only RPC inputs, and whether the SQL advisory lock/default-workspace/count/
insert and ACL behavior are atomic and safe. Do not apply databases, deploy,
commit, push, or alter unrelated reviewed SMS code.
