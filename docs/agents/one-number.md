# One number + vendor dispatch (builder notes)

## W7b - Vendor dispatch in the portal (roles, rules, runs, vendor offers)

Portal side of vendor dispatch. The engine (matching, run state machine, texting) is
`src/lib/vendor-dispatch/runs.server.ts` and friends (W7a); this workstream never edits
it. Tables: `20261018120000_vendor_dispatch_rules.sql` (no new migration here).

**Vendor roles on the roster row** (`manager_vendor_records.row_data`):
`dispatchTrades` (ids from `VENDOR_TRADES`), `serviceArea`, `dispatchRateCents` +
`dispatchPayModel`, `insuranceExpiresAt` (yyyy-mm-dd), `licenseNumber`, `dispatchAvailable`
(absent = available; only `false` takes the vendor out of dispatch). Normalized on every
read and write by `normalizeVendorDispatchFields` (`vendor-roles.ts`) inside
`normalizeRow` in `/api/portal-vendors`: unknown roles, bad numbers and impossible dates are
stripped. `vendorDispatchRoles(row)` returns the explicit roles, else maps the legacy
trade labels ("Plumbing" -> plumber); use it (not `row.trade`) wherever the engine asks
"does this vendor take this job". Edited on the vendor form's Dispatch step; shown as a
glyph fact on Your vendors rows; Filter > Dispatch role narrows Your vendors.

**Dispatch rules** (`rules.ts` pure validator, `rules.server.ts` CRUD, `access.server.ts`
actor): routes `GET/POST /api/portal/vendor-dispatch/rules`,
`PATCH/DELETE .../rules/[id]` (PATCH `{ active }` pauses). Workspace and owner are
re-derived from the session (`resolveActiveWorkspaceFromRequest`), never the body. Every
vendor id must be a `manager_vendor_records` row of the workspace owner; every house id must
be in `workspace.propertyIds`. A co-manager needs the Services module (`linkedOwnerScopeForModule`):
read to list, edit to create/update, delete to delete; a workspace-wide rule needs every
house of the workspace, a selected rule every listed house; a rule on houses they do not hold
reads as not found. Chain order = `vendor_dispatch_rule_vendors.position` (0 = primary).
UI: Vendors > Dispatch tab (`dispatch-rules-list.tsx`), editor `dispatch-rule-editor.tsx`
(Job, Houses, When, Vendors, Offer, Pay).

**Runs on the service record**: `GET /api/portal/vendor-dispatch/runs?sourceType=&sourceId=&status=`
(read, scoped to workspace + owner, house-scoped for co-managers; through `sharedGet` via
`useDispatchRuns`) and `POST .../runs/[id]` `{ action: approve | pick(position) | decline |
retry | broadcast | cancel }`, which calls `runs.server.ts` with `channel: "portal"` and the
session as approver. Dispatch is a section on the service Overview
(`service-dispatch-section.tsx`) and a Services Filter field ("Waiting for your approval");
it is never a stage bucket (`service-lifecycle.ts` vocabulary unchanged).

**Vendor portal**: `GET /api/vendor/dispatch-offers` (own offered attempts; `offer_text` only,
no house or workspace id) and `POST /api/vendor/dispatch-offers/[attemptId]` `{ answer }`
(`vendor-offers.server.ts`). The answer is a compare-and-set: attempt `offered -> accepted |
declined`, then run `offering -> accepted`; the SMS parser must use the same transitions.
Shown above the Open tab of the vendor's Services (`vendor-dispatch-offers.tsx`).

Tests: `tests/unit/vendor-dispatch-{rules,rules-route,runs-route,vendor-offers}.test.ts`.
