# PRP-456 release review — 2026-09-09

Release request: promote the completed `prakrit` batch through main and staging QA to production. PRP-457 lease-type pricing remains unfinished in a separate worktree and is excluded.

## Reviewed history

- Existing production: `57db1336`.
- Captain batch: `f70b9ef8`, then delta `f70b9ef8..906ea492`.
- Independent security-review and bugbot reviewed the initial batch, then the captain delta alongside no-mistakes corrections through `bb00e72e`.
- Combined candidate: `74840c75`, plus the resident-readiness correction in this commit.
- No-mistakes run `01M24AQVVZ2J55CAMVD300TH44` completed review at `6244fd7d`; its test/document/lint stages are still running at this checkpoint. This is not a completed release gate.

## Resolved findings

High/medium findings corrected by the pipeline: owner-only portfolio waiver conversion; empty co-manager grants deny; verified property-owner access retained; waiver conflict prevalidation; single-property code editing with bulk automation saves omitting code fields; effective reminder channels shown and preserved; explicit overrides honored by send-now and late-fee delivery; legacy portfolio code scope disclosed accurately; tour reminder channel props threaded; hermetic late-fee regression moved into the unit gate. Source comments now match empty-grant denial.

Security re-review found no new high/critical findings in `f70b9ef8..906ea492` or its interaction with fixes through `bb00e72e`. The co-manager onboarding change only affects client loading decisions and does not grant server access.

Bugbot found a P2 in `955df43c`: Residents waited for unrelated inbox/service/charge requests. The directory now waits only for properties, applications and leases; detail feeds refresh separately. A real-browser regression holds the inbox request pending and verifies the seeded directory renders.

## Cache, rendering and native parity

The new readiness gate preserves the existing TTL/coalesced refreshers and event invalidation. No new routes, duplicate native UI, or native plugins were added. Tour grid extent changes remain in the existing calendar surface. Manual checks still required: noon/midnight end slots, narrow modal bottom clearance, co-manager cold load and failure, resident stage convergence when lease/application requests finish in opposite orders.

Residual pre-existing concerns: an account-links failure after an earlier success clears cached invites while retaining the known flag; residents-only delegates still depend on restricted lease data for directory stage labels. These are not grounds to loosen lease-document authorization.

## Validation checkpoint

- Production build: exit 0, dev/test DB pinned; compiled browser bundle contains only `emstjswhotsnyksqhqyf.supabase.co`.
- Local sign-in page: meaningful render, no browser errors.
- Four latest-delta unit files: 38 passed.
- Pending-inbox browser regression: 1 passed.
- Full browser suite: running; no overall pass claimed.
- Read-only metadata checks: staging and production both lack waiver `property_id` and scoped redemption. Staging has account recovery; production does not. Migration history names alone do not establish schema parity.
- GitHub ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_P8 names present. No production push performed.

## Production database handoff

`supabase/migrations/20260909210000_scope_application_fee_waiver_codes_to_property.sql` is required before this batch reaches production. It adds the property column/index and scoped redemption function, and backfills waiver rows labelled `listing:<propertyId>`. The repo prohibits agents from production data writes, so an operator must apply the production migration after staging validation. Do not replay historical restore/seed migrations or infer safety from version numbers alone.
