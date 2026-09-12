# Bounded upstream migration review

Reviewed 2026-09-12 against upstream `01c6af066`. This is a source review of two missing migrations and their immediate callers, permissions, and account-purge classification. No database access, SQL application, secrets access, implementation edits, or release actions were performed. The SMS implementation is outside this review.

## Recommendation

- Payment-preferences migration: suitable to seek bounded application authorization, subject to the exact-target metadata backup and fail-closed transactional apply checks below. No blocking source finding in this migration.
- Plan-add-ons migration: **do not present this as safe activation yet**. Its DDL does not mutate existing business rows, but creating the table makes already-deployed add-on writes succeed, including the unbilled entitlement path below. Resolve or explicitly gate that path before production application. The workspace ceiling change also needs atomic plan-cap enforcement.
- These are independent commercial feature migrations, not SMS batching behavior. Missing migration history does not authorize applying them alongside SMS work.

## Exact artifacts

Both worktree files were byte-compared with `git show 01c6af066:<path>` and match.

| File under `supabase/migrations/` | SHA-256 |
| --- | --- |
| `20260912120000_payment_preferences_promo_coverage.sql` | `aacb7a687588c15f479f3e8fc87ddae3d40d17c8de7b8229c98defde9890fe74` |
| `20260912201050_manager_plan_addons.sql` | `586ca8c1fe00fb254335ade510f53781b55bd74a93fc0b12cb0db22070ef72d0` |

## Findings in code activated by the add-on migration

### High: a missing Stripe subscription grants add-ons without payment or explicit comp authorization

`src/lib/plan-addons.server.ts:113-169` checks the effective Pro/Business tier, then executes all Stripe validation and price-configuration checks only inside `if (subscriptionId)`. With no subscription it unconditionally upserts the requested quantity and returns success with `stripeSynced: false`. `POST /api/manager/plan-addons` accepts any authenticated manager's own addon ID and quantity; it does not require staff authorization for this branch.

The code comment intends this exception for comp/admin grants, but `resolveEffectiveManagerSkuTier` also returns Pro/Business for active signup trials and Apple-managed paid accounts (`src/lib/manager-access.ts:143-162`). The existing trial test confirms this. A current Pro trial can POST `extra_listing` quantity 100, pass every check without configured Stripe addon prices, and receive 100 stored extra listing units without purchasing them. Comp eligibility and billing method are available in `getManagerPurchaseSku` but are never checked here. Creating the absent table turns a previously failing final write into successful entitlement activation.

Required resolution: fail closed for unsupported billing methods and trial purchases, and make any complimentary add-on quantity an explicitly authorized grant rather than treating every absent Stripe subscription as one.

### High: Stripe mutation and entitlement persistence can diverge and duplicate billing

`src/lib/plan-addons.server.ts:130-177` ignores errors reading the existing Stripe item ID, mutates Stripe, then upserts the database. No idempotency key, operation record, lock, or compensation reconciles these steps. If Stripe creates an item and the DB write fails, a retry sees no saved item ID and creates another subscription item. Concurrent first purchases can do the same. Ignoring a failed item-ID read also takes the create branch despite a potentially existing item. This is a static control-flow finding; no Stripe calls were made.

Required resolution: reject item reads on error and use durable, idempotent purchase operations with reconciliation before opening writes that alter recurring billing.

### Medium: raising the workspace trigger ceiling leaves the actual plan cap outside the lock

The old trigger atomically capped every owner at three workspaces. The new trigger caps only at ten. `src/app/api/workspaces/route.ts:73-84` reads usage and the plan cap before the separate insert request, while only the SQL trigger acquires the owner advisory lock. For a Business manager with two workspaces and no add-ons, two concurrent creates can both read `2 < 3`; the new trigger admits both, leaving four workspaces without an add-on. The old trigger refused the fourth. Pro's lower plan cap was already subject to this class of race, but the migration expands the exposure to the Business bundle.

Required resolution: resolve/recheck the effective plan plus purchased cap within the serialized database creation operation. The hard ceiling can remain ten.

### Medium: add-on workspace reads fail to zero rather than report unknown

`src/lib/workspaces/server.ts:137-154` replaces an errored add-on read with zero quantities while `unknown` reflects only the base-tier read. Workspace creation can therefore incorrectly refuse a purchased workspace after a transient add-on read failure. This conflicts with the entitlement documentation's rule that unreadable paid entitlements are not zero. The add-on table loader itself correctly distinguishes most read errors; this caller discards that distinction.

## SQL and permission assessment

The payment SQL drops only the old two-argument RPC and creates the three-argument version with `p_coverage_granted default false`. It revokes all execution from PUBLIC, anon, and authenticated, then grants service_role execution. The security-definer function pins its search path and fully qualifies the target settings table. The route derives the manager ID from the session; the server helper computes the grant, strips any supplied admin override, and calls the new signature. Inside the RPC a row lock serializes the settings update, strips the caller's admin override, and restores the stored staff value. An ungranted `proplane` choice is downgraded to `resident`. Stored override precedence remains the downstream fee resolver's responsibility.

The new boolean is deliberately trusted service-role input, not independently validated SQL promo evidence. That is acceptable only with the service-role-only ACL verified after apply. A transaction must contain the function creation and ACL statements so no intermediate default PUBLIC execute grant becomes externally visible. Existing two-argument callers resolve the new defaulted signature; the deployed reviewed caller passes three arguments explicitly. Removing the old overload avoids ambiguity.

The add-on table has RLS enabled, no client policies, and all PUBLIC/anon/authenticated table privileges revoked. service_role has table privileges. Its composite primary key scopes one quantity per manager and addon; checks restrict the four known IDs and integer quantities 0-100. `profiles(id) ON DELETE CASCADE` removes rows when a profile is removed. `src/lib/auth/account-purge-manifest.ts:332` additionally classifies `manager_plan_addons` in phase 2 by `manager_user_id`, including manager-portal deletion where another portal remains.

The workspace trigger remains security-definer, has a pinned public search path, references the table as `public.portal_workspaces`, and preserves the advisory lock and existing default-workspace conflict handling. Client execution is revoked. Replacing its function body does not detach the existing trigger.

## Apply-time data scope

Neither reviewed file has top-level INSERT, UPDATE, DELETE, TRUNCATE, or an invoked business-writing function. The payment INSERT/UPDATE statements are only inside the newly defined function and execute on later calls. Creating the add-on table creates it empty if absent; replacing the workspace function does not execute its trigger against existing rows. No existing property, listing, payment, charge, or settings row is changed by these two migration bodies alone, and no migration body touches the locked listings.

This is not a claim that applying the migrations leaves subsequent application behavior unchanged. Payment saves gain promo support; add-on API writes gain a real storage table; workspace creates gain a higher global ceiling. Normal traffic may write after application. Supabase migration bookkeeping also changes independently of business-row DML.

## Bounded apply prerequisites for any approved file

1. Name the precise database project and exact migration SHA-256 in the authorization and execution plan. Read-only review does not authorize production changes.
2. Verify prerequisite objects: `manager_automation_settings.manual_payments`, the prior RPC definition, `profiles`, `portal_workspaces`, and the existing workspace trigger as applicable. Capture current function definitions, ACLs, relevant table metadata, trigger attachments, and migration history before apply.
3. Fail closed on unexpected existing `manager_plan_addons` shape or privileges. `CREATE TABLE IF NOT EXISTS` is not a schema-parity check and will not repair an unexpected existing table.
4. Apply only the approved exact files through the reviewed transactional path, then verify installed definitions, signatures, ACLs, RLS/check/FK/PK metadata, trigger attachment, and migration-history entries. Do not use a broad push that includes unreviewed missing migrations.
5. Do not roll back by dropping an add-on table after traffic may have written quantities. A rollback must preserve newly created records and account for external Stripe side effects.

## Validation and limits

- `npx vitest run tests/unit/admin-service-fee-override-ownership.test.ts tests/unit/evidence-manual-payment-settings-route-waiver.test.ts tests/unit/account-purge-coverage.test.ts`: exit 0, 3 files and 10 tests passed.
- `npx vitest run tests/unit/manager-trial-expiry-quota.test.ts`: exit 0, 1 file and 7 tests passed.
- These are local mocked/unit checks, not a real PostgreSQL migration run, role probe, Stripe purchase test, or concurrent workspace browser test. They do not dismiss the findings above.
- Graphify query was attempted using default and explicit `.graphify/graph.json` paths; neither graph exists in this pool checkout. Review used the area documentation and scoped source reads. No graph was rebuilt for this documentation-only report.
- No implementation files were modified. Existing source findings are recorded for the root task to scope; they were not silently repaired or expanded into unrelated upstream UI work.
