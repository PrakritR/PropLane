# SMS rollout prerequisites - fresh Astra review

Reviewed 2026-09-12 after the Sol implementation handoff. This review covers the bounded purchase-closure and atomic-workspace prerequisites, not a fresh review of all earlier SMS work.

## Exact revision and scope

- Checkout: `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/5/AXIS-2`
- Branch: `prospect-sms-release`
- Patch base and unchanged HEAD: `a4967b835880ad44b13b10c1fcc112de80081fbe`
- Common ancestor with the locally recorded `origin/production`: `01c6af066f4200a8f5ecdfe900fd1239a6ffc3fb`. No remote fetch was performed.
- Reviewed dirty tracked files: `src/app/api/manager/plan-addons/route.ts`, `src/app/api/workspaces/route.ts`, `src/lib/plan-addons.server.ts`, `src/lib/workspaces/server.ts`.
- Reviewed untracked implementation: `supabase/migrations/20260913001000_atomic_workspace_plan_limit.sql`.
- Reviewed SQL SHA-256: `0c1924b8a0e2339d6bb6ae370ff2823badb5374bde51f157b788ac09b3cfe36c`.
- Reviewed untracked tests: `tests/unit/manager-plan-addons-closure.test.ts`, `tests/unit/workspace-plan-addons.test.ts`, `tests/unit/workspaces-create-route-contract.test.ts`, `tests/unit/atomic-workspace-plan-limit-migration.test.ts`, `tests/integration/atomic-workspace-plan-limit-postgres.test.ts`.
- Context artifacts: `docs/plans/2026-09-12-sms-production-activation.md`, its `-handoff.md`, and `docs/plans/prospect-sms-upstream-migrations-review.md`. The two previously reviewed pending migration bodies were read as prerequisites; this review did not change them.

## Recommendation

The purchase mutation closure and new SQL locking/permission design satisfy their bounded security requirements. Resolve F1 before claiming complete fail-closed workspace entitlement reads. F2 is a low-severity UI consequence for accounts with existing quantities, not a billing bypass. No critical or high-severity finding was found in this patch. Staging browser QA, exact-target schema verification, transition gates, full release checks, and deployment verification remain root responsibilities.

## Findings

### F1 - Medium / P2: schema-cache failures still become a known zero-add-on plan

Location: `src/lib/plan-addons.server.ts:32-38`, consumed by the changed `src/lib/workspaces/server.ts:139-144`.

The shared loader still returns `ok: true` and zero quantities whenever an error names `manager_plan_addons` and contains `does not exist` or `schema cache`. Consequently the new `unknown = !tierResult.ok || !addons.ok` does not cover those errors. A schema-cache miss cannot establish that the account holds no purchased quantities. With a known Business base tier and unreadable extra-workspace rows, the response reports a known limit of three; the create route can incorrectly reject purchased capacity with its upgrade message, or proceed with an unverified lower cap.

This compatibility branch predates the patch, but it remains an uncovered edge of the explicitly requested unreadable-entitlement fix. The plan says missing entitlements remain unknown and all reviewed targets receive the table. Root confirmed that the rollout requires strict failure after schema activation: remove the missing-table/schema-cache success fallback from the shared loader. Test both PostgREST schema-cache errors and PostgreSQL missing-relation errors through `loadWorkspacePlan`, and verify create returns 503 without the creation RPC. A successful empty result must still mean zero quantities.

Independent local reproduction loaded the actual TypeScript helper using `typescript.transpileModule` in a Node VM with a stub database and no network. Both `Could not find the table 'public.manager_plan_addons' in the schema cache` and `relation "public.manager_plan_addons" does not exist` returned `ok: true` with four zero quantities; the timeout control returned `ok: false`. Command exit: 0. The new unit test covers only a timeout and misses this distinction.

### F2 - Low / P3: an existing add-on still offers a Remove action that always fails

Location: unchanged consumer `src/components/portal/manager-plan-addons-panel.tsx:153-157`, affected by the changed helper closure and catalog.

The catalog correctly makes Add unavailable, but Remove is enabled whenever quantity is positive and no request is busy. The shared mutation boundary now rejects every quantity change, including decreases. An account holding an existing add-on therefore sees an enabled Remove action that can only produce the unavailable notice. Quantities remain correct and no charge/write occurs. Empty-table activation has no immediate affected existing quantity, so this is not a reason to reopen purchases. Root confirmed that this bounded correction should include disabling Remove when `!row.purchasable`. Align the removal availability/copy with the deliberately closed write boundary; do not reintroduce the unsafe billing path. Verify a positive-quantity row during staging QA.

## Bounded correction plan

Root confirmed one combined correction cycle for both findings. A fresh Sol implementation pass should:

1. Remove the missing-table/schema-cache zero-quantity fallback from `loadManagerPlanAddonQuantities`. Every returned database error must yield `ok: false`; a successful empty query must retain zero quantities.
2. Add focused coverage for missing-relation, schema-cache, and ordinary read errors through the real workspace-plan loader, plus the route's unknown-plan 503/no-creation-RPC contract and a successful empty-read control.
3. Disable the existing Remove button when `!row.purchasable`, matching Add. Keep the shared purchase boundary closed. Root reports no existing add-on rows in staging or production, so no active paid cancellation flow needs migration in this release.
4. Run relevant tests, scoped lint, TypeScript if warranted by the final edits, and normal diff checks. Root should add positive-quantity/read-failure browser states to its staging QA. No SQL correction is required by this review; preserve the reviewed migration hash.
5. Return the final changed-file list and exact validation evidence for a fresh Astra check. Root owns the separate migration-runner/drain/header/ledger review and all external operations.

## Security and correctness checks

- `setManagerPlanAddonQuantity` preserves identity/quantity errors, then returns the stable unavailable result unconditionally. Stripe imports, mutation logic, service-role client construction, and entitlement writes were removed. No environment variable can reactivate them.
- The catalog returns `purchasable: false` independently of price configuration. The route derives the manager identity from authentication. Existing successful quantity reads remain available.
- Workspace create retains the manager authorization gate, takes the owner from the authenticated session, derives the cap using the existing effective-tier path, ignores body owner/cap values, and refuses an explicitly unknown plan before invoking creation.
- The new RPC validates owner, name, and limit 1..10; uses an empty search path and qualified relations/functions; revokes PUBLIC, anon, and authenticated execution; and grants service_role execution. The service-role-only boundary is essential because the SQL deliberately trusts the server-derived cap.
- The advisory lock key matches both the installed ceiling trigger and default-workspace helper. Default creation, count, and named insertion occur in the same transaction while holding that lock. A null result maps to 409; the courtesy precheck maps to 403. Reserving the default at a one-workspace cap is intentional and tested.
- The migration adds one function and no table or top-level business-row mutation. It does not need a new account-purge entry. The reviewed add-ons table already has its purge classification and denies client writes.
- No new portal navigation, native shell, rendering, or observability surface was introduced. Browser QA remains necessary for the affected existing flows and F2.

## Validation evidence and limits

- Independently inspected the complete four-file source diff, SQL, five test files, immediately affected UI consumers, existing workspace trigger/default helper, and upstream migration review. Verified HEAD, common ancestor, migration hash, and `git diff --check` (exit 0).
- Sol handoff reports focused unit tests: exit 0, 20 tests; scoped lint: exit 0; TypeScript: exit 0; disposable local PostgreSQL tests: exit 0, four tests including 12 concurrent final-slot creators, ACLs, default accounting, and invalid input. Root separately reports an independent four-test PostgreSQL pass. These results were read as supplied evidence, not rerun or claimed as this reviewer's execution.
- The real PostgreSQL rehearsal uses a minimal fixture and a simplified ceiling trigger; exact deployed prerequisite definitions and ACLs must still be verified by root.
- Graphify `review-delta` is unsupported by the installed executable. Both default and explicit graph queries found no graph in this pooled checkout. Review used repository area documentation and scoped source inspection; no semantic graph claim is made.
- The installed feature-cycle skill was read. Its referenced `docs/agents/akhil-feature-cycle.md` is absent in this checkout; the explicit assigned fresh-review task, root/Akhil instructions, plan, and handoff supplied the review contract.
- No credentials, network, database, customer messages, implementation changes, commit, push, or deployment were performed by this reviewer. The only persistent edit is this report. Full unit/build and staging/browser/release operations run independently in the root task.
