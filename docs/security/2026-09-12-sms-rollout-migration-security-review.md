# SMS rollout migration security review

Reviewed 2026-09-12 against HEAD `a4967b835880ad44b13b10c1fcc112de80081fbe` plus the prerequisite diff in the pooled checkout. Scope: three SQL files, add-on purchase closure, atomic workspace boundary, and the private capture/prepare/apply/verify scripts. This review made no external calls, obtained no credentials, applied no SQL, and sent no messages to customers.

## Decision

The three pinned SQL files and the new purchase/workspace boundaries have no blocking SQL authorization or concurrency finding. **Do not apply using the reviewed runner unchanged:** close the request-drain gap and strengthen denial evidence below. Root owns those operational corrections, staging application/QA, and production application/release. This is a source review, not evidence of deployed gate activation or successful application.

## Exact pins

| Artifact | SHA-256 |
| --- | --- |
| `supabase/migrations/20260912120000_payment_preferences_promo_coverage.sql` | `aacb7a687588c15f479f3e8fc87ddae3d40d17c8de7b8229c98defde9890fe74` |
| `supabase/migrations/20260912201050_manager_plan_addons.sql` | `586ca8c1fe00fb254335ade510f53781b55bd74a93fc0b12cb0db22070ef72d0` |
| `supabase/migrations/20260913001000_atomic_workspace_plan_limit.sql` | `0c1924b8a0e2339d6bb6ae370ff2823badb5374bde51f157b788ac09b3cfe36c` |
| `src/lib/plan-addons.server.ts` | `09768d92e1a75ca9294db762a6ca1bb3767b212f25142f42c0da0e6e474ec6c8` |
| `src/lib/workspaces/server.ts` | `66efd2a8614585fb422f264508c71f90ee81b08f013f38e9d0cd9968d8ca174d` |
| `src/app/api/workspaces/route.ts` | `fe72ff8c8c4fcfa9776184e63e32ef3b3e48fb7870c3ceb28aa327a6129ba486` |
| `src/app/api/manager/plan-addons/route.ts` | `065426b3562236f00d76b7c0a2449ea65b0bc03ce4ba399baf3924979bf7e47b` |
| private `migrate.mjs` | `6b1aa7cb46ca36e4ee4ed53e97717b873b8218470b5472e7851fc54bf8565343` |
| private `db-common.mjs` | `cc74aefea9e476171fa6416545d790959591e0fc8a092d5382f07757147a1f4a` |
| private `capture.mjs` | `8350d7620bf55068d94dc38b46ee75269a98f7f75250ef21d99f225ccd719929` |
| private `reviewed-migration-manifest.json` | `71118775bbe92c208d6a72ae5553ad7c3a0dbad040ccaf54f91e953fa158b751` |
| imported `scripts/apply-20260911-comms-billing-migrations.mjs` | `56e88313a0da9b14ef04e4d146392782a79085e80ff04266149e8a6f9be09cc6` |

Private artifacts are under `/private/tmp/proplane-sms-activation/`. Their contents and backups must remain private. Correcting any reviewed artifact invalidates its old pin; record and review the new pin before apply.

## Required operational corrections

### High: publishing the gate does not drain requests already admitted

Private `migrate.mjs:39-43,56-58` checks the published firewall and immediately permits schema application. A POST admitted before the firewall was published can still be executing the old add-on purchase or workspace implementation. If it reaches its entitlement upsert or workspace insert after the missing table/higher trigger ceiling becomes available, the unsafe implementation can succeed despite new POST requests being denied.

Correction: preserve a verified gate publication/observation timestamp, resolve the actual deployed maximum execution duration, and require a full drain interval plus propagation margin before the first activating DDL. Recheck the same published rule and denial evidence after the drain and immediately before application. Equivalent positive evidence that all pre-gate executions have ended is acceptable. Keep the gate closed throughout any partial apply, failure, deployment, and QA. Do not infer drain completion from a successful new-request probe.

### Medium: generic response text is weaker than the promised Vercel denial proof

Private `migrate.mjs:42` accepts HTTP 403 with either `x-vercel-mitigated: deny` **or** a body containing `Access Denied`. An application or deployment-protection page can satisfy the latter without proving this firewall rule intercepted the request.

Correction: require HTTP 403 and the exact Vercel denial header for both routes on each target. If the platform does not expose that header, use another verified platform-specific denial identifier with documented provenance; do not silently use generic page text. Continue requiring an active exact-method/path rule, firewall enabled, and no unpublished draft.

## SQL and application findings resolved by the implementation

- Add-on writes stop at the shared helper after identity/quantity validation. No service-role or Stripe client is constructed there; the old mutation path was deleted. All catalog entries report `purchasable: false`. Trial, Apple/no-subscription, comp, and Stripe-backed callers cannot reach the previous unbilled-grant/duplicate-charge paths once this code is deployed.
- The new workspace RPC validates owner, trimmed name, and cap 1..10. It locks the same `workspace-owner:` key used by the existing default helper and trigger; creates the default under that lock; counts owned rows; and inserts only below the server-derived cap. The default can be created even when the named request is refused at cap 1, matching the documented initialization behavior.
- `POST /api/workspaces` derives the owner from the authenticated session, checks manager eligibility, and derives the cap from `loadWorkspacePlan`. Request-supplied owner/cap cannot widen the RPC. The RPC is security-definer with an empty search path, qualified table/function references, and PUBLIC/anon/authenticated execute revoked. The existing table is client read-only in its reviewed migration.
- The payment function's defaulted coverage argument remains trusted service-role input. Existing staff override preservation and ungranted `proplane` downgrade remain intact. Creation/revocation must stay within the CLI migration transaction so default PUBLIC execution is never published between statements.
- The add-on table starts empty, has no client policies, enables RLS, revokes client privileges, and uses constrained IDs/quantities, owner-scoped primary key, and profile cascade. Account-purge classification was covered in the upstream review.
- The three files contain no top-level business-row INSERT/UPDATE/DELETE or invoked business-writing functions. They do not touch locked listings. Supabase history rows and authentication bookkeeping are expected operational writes. Backups contain schema and catalog/history metadata, not a full business-data snapshot; that matches this DDL-only scope.

## Runner assessment and remaining verification limits

The runner allowlists staging `xwszcafaontidfgznlxd` and production `qahnczmilgptcedaqype`; manifest hashes pin the only three pending raw SQL files. It refuses pending-name/version collisions, extra pending repo names, drift in captured ledger/functions/tables/triggers, an existing add-on table, or an existing new RPC. Private CLI directories must exactly match the historical ledger mirror plus the three files. Every historical mirror raises if replayed, preventing accidental execution of synthetic history. Existing history is not repaired or rewritten by the script.

The imported connection helper binds direct-host or pooler identity to the exact project, pins the CA, and enables hostname/certificate verification. `connect()` additionally checks encrypted/authorized TLS. Capture uses `pg_dump` with `verify-full`; catalog reads use read-only transactions. This review did not independently inspect the implementation of the pinned Supabase CLI binary's write-connection TLS/transaction handling. Root must retain the repository-required CLI migration transaction behavior; the three-file invocation is not claimed here to be one all-or-nothing bundle. On any failed or timed-out apply, inspect committed ledger/catalog state before retrying and keep the gate closed.

Post-apply verification checks new identities, preserved historical ledger, exact function bodies, signatures, owner, definer status, search paths, effective client/service execute permissions, unchanged default helper and trigger attachment, table columns, RLS, grants, and key constraints. Two limits should be addressed or recorded in rollout evidence:

1. New ledger `statements` are checked only for nonempty content (`migrate.mjs:27`), not equivalence to the reviewed SQL. Compare their canonical statement sequence against the pinned source when auditing the installed history. The installed function-body/ACL checks and source/mirror pins provide separate protection, so this is an audit completeness item rather than a demonstrated unsafe SQL path.
2. Column defaults and exact check definitions are not fully compared; business-row counts are captured but not asserted unchanged. After application inspect defaults and count differences explicitly. Ordinary traffic can change counts, so unexplained changes need investigation rather than an automatic claim that the migration wrote them.

Pre-existing read caveat: `loadManagerPlanAddonQuantities` still converts missing-table **or any matching schema-cache error** into successful zero quantities (`src/lib/plan-addons.server.ts:32-36`). Ordinary read errors now propagate to `loadWorkspacePlan.unknown`, but a post-install schema-cache outage can still appear as zero purchased capacity. The current rollout creates an empty table and closes purchases, so it does not itself create paid quantities at risk. Remove or narrowly constrain that compatibility fallback before making an unconditional unknown-read guarantee or reopening add-on purchases.

## Evidence inspected

Both private backup manifests matched independently recomputed schema/catalog hashes. Both baseline catalogs show the old two-argument payment signature, no add-on table, no atomic workspace RPC, service-role-only execution of the existing functions, and the expected RLS-enabled prerequisite tables. Both saved Supabase CLI dry runs report exactly the three pinned SQL filenames, with empty seed and role lists. No backup contents or personal records were copied into this report.

Implementation handoff reports 20 focused unit tests, scoped ESLint, TypeScript, and four real local PostgreSQL tests passing. Root reports independently repeating the four PostgreSQL tests, including 12 concurrent last-slot callers, ACLs, default counting, and invalid inputs. Those are attributed results; this reviewer did not rerun them or claim they prove staging/production behavior.

Graphify query was attempted and exited 1 because no graph was available at its expected path. Review used the authoritative plan/entitlement docs and scoped source reads. No graph refresh was required for this documentation-only change.
