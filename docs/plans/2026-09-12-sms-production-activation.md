# SMS production activation and bounded migration prerequisites

User: Akhil. Explicitly authorized 2026-09-12: apply missing migrations and promote to production after completion. Existing production SMS authorization persists. No customer SMS recipient has been designated.

Implementation checkout: `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/5/AXIS-2`, branch `prospect-sms-release`, HEAD `a4967b835880ad44b13b10c1fcc112de80081fbe`. Preserve the dirty original workspace. The original workspace remains untouched; release implementation and validation use the pooled checkout.

## Evidence and release objective

The SMS publisher, 20-second batching, signed QStash callbacks, duplicate publication, silent read-only GPT snapshots, and automatic shadow deadline were reviewed in the prior cycle. Full frozen suite: 9,981 tests passed. OpenAI now returns 200/completed after the user added credits; Langfuse authentication also returns 200. Latest remote main/production remain 01c6af066. The remote staging branch is absent and must be restored for QA, never skipped.

Two absent migration names are payment_preferences_promo_coverage and manager_plan_addons. Review at `docs/plans/prospect-sms-upstream-migrations-review.md` found unsafe add-on purchases and a workspace-cap race. Installing a missing table must not silently activate those defects. This release installs the schema while holding purchases closed; it does not implement a new recurring-billing workflow.

## Bounded code changes

1. Close add-on purchasing at the shared `setManagerPlanAddonQuantity` boundary before any Stripe mutation or entitlement write. Return a stable unavailable result with honest product copy. Do not retain an environment toggle that can reactivate the known unsafe implementation. Remove unreachable unsafe mutation code rather than keeping a bypass. Catalog `purchasable` must agree so the existing UI accurately represents availability. Reading quantities and existing plan limits remains supported. Retain read/identity/error contracts.
2. Make workspace creation count and insert atomic through one new service-role-only RPC. The authenticated server continues to derive owner and limit from `loadWorkspacePlan` and the existing effective-tier resolver. The RPC takes the server-derived cap, validates it within 1..10, uses the SAME workspace-owner transaction advisory lock as the existing trigger, counts owned rows under that lock, and inserts only below the cap. Pin search_path, qualify objects, revoke PUBLIC/anon/authenticated execute, grant service_role only. Ensure default-workspace creation remains counted correctly. Avoid duplicating the TypeScript plan resolver in SQL.
3. `/api/workspaces` create uses the RPC and maps cap refusal appropriately. An add-on read failure makes `loadWorkspacePlan` unknown and creation fail closed; do not present a failed read as zero purchased capacity. Keep errors honest and avoid unrelated UI changes.
4. Additive migration only; do not rewrite either existing pending migration. No new tables beyond the already-reviewed add-ons table, so no new purge classification should be needed for this bounded RPC.

## Rollout sequencing owned by root

Root must preserve exact target catalog, function definitions/ACLs, migration history, and relevant row counts before writes. Prepare a pinned, reviewed, transactional apply path using the existing Supabase workflow. Only the two reviewed pending files and the new atomic-workspace RPC are allowed; inspect actual ledger names and source hashes first. Do not mutate locked listings or unrelated business rows.

Before schema activation, root will arrange a narrow temporary gate for POST requests to `/api/manager/plan-addons` and workspace mutations if necessary, with a backed-up configuration and proof that no unrelated firewall draft is published. This prevents old deployed code from using newly installed schema during the deployment transition. If that gate is unavailable, return the concrete sequencing constraint for root to resolve; do not apply unsafe migrations speculatively.

After code review and tests: keeper -> main -> restored staging, apply reviewed staging schema through the guarded path, staging QA, apply reviewed production schema while transition gates remain closed, production promotion, verify exact web deployment and TestFlight internal distribution, remove only our temporary transition gates after the new route guards are verified. Maintain fast-forward pushes, no PR, no no-mistakes.

Enable QStash only with the fixed publisher deployed. Enable the funded GPT shadow with an explicit UTC expiry 24 hours after activation and conservative existing drain limits. Compare real frozen evidence silently, persist results and Langfuse traces; no GPT response may reach SMS or write tools. Test on isolated staging records without sending to unapproved phones. Report the limit if actual Twilio delivery cannot be tested without a designated phone.

## Tests and execution responsibilities

Fresh Sol-medium manages Terra implementation and Luna independent tests/review. Suggested ownership: Terra helper/catalog closure and workspace RPC/route; Luna tests and read-only SQL/auth review, serialized if needed to avoid overlap. Scope only the named code, additive SQL, relevant tests and handoff docs. Agents do not access credentials, call external APIs, apply DB changes, deploy, commit or push.

Reproduce purchase attempts through the real route/helper boundary with trial, Apple/no-subscription, Stripe-backed and unauthenticated contexts; assert zero Stripe and entitlement writes and catalog unavailable. Exercise normal and unknown workspace plan reads, owner identity derivation, invalid cap/name, and concurrent final-slot creates. Include a real local PostgreSQL concurrency/ACL rehearsal if available; root owns staging DB QA. Read relevant installed Next guides before route edits. Run focused tests, scoped lint, TypeScript, diff-check, and required graph refresh (report the known unavailable executable honestly). Write a durable handoff in the pooled checkout; root owns full unit/build and fresh Astra/security review.

Acceptance: no free add-on grants or duplicate recurring charges can be triggered through the closed purchase boundary; workspace count arbitration is atomic; missing entitlements remain unknown; all migrations are independently reviewed and verified on each target; staging precedes production; batching and silent GPT activation are verified without double customer texts.
