# Group applications & lease bundles

Moved out of the root `AGENTS.md` to keep it loadable; this is the
authoritative copy. Read it before changing code in this area.

## Group applications & lease bundles (independent accounts)

A "group application" (roommates / a bundled lease household) is **several
independent applications tied by a shared Group ID**, never one merged record.
Each member keeps their own application row (`manager_application_records`), own
email, own AXIS id, own screening, and — once approved — their own resident
account and single-resident `LeasePipelineRow`. Nothing about the group changes
the 1-application → 1-account → 1-lease model; the group is a **reconciliation
view**, so every resident on a bundled lease still owns an independent login,
portal, and identity while the household reads as one unit.

- **Shared Group ID (`AXISGRP-…`).** The first applicant mints it on submit
  (`resolveSubmitGroupId` in `src/lib/rental-application/application-groups.ts`);
  it is stored on `application.groupId` in that member's snapshot and echoed on
  the finish screen (`rental-application-finish-panel.tsx`) to copy/share.
  Joining applicants paste it in wizard step 1 (`rental-wizard-steps.tsx`) and it
  validates via `validateAxisGroupId` (prefix + length ≥ 12).
- **Reconciliation is pure + testable.** `application-groups.ts` groups rows by
  normalized `groupId`, derives expected size from the first applicant's
  `groupSize`, and computes `submittedCount` / `missingCount` / `isComplete`.
  `manager-applications.tsx` renders a "Group N/M" row badge plus an expanded
  application detail roster (`ApplicationGroupSection`) with the Group ID and
  member statuses; the same roster also surfaces on `manager-residents.tsx` and
  `resident-applications-panel.tsx` after approval.
- **No silent deadlock.** A group never *blocks* — approvals stay per-member.
  An unfinished member surfaces as "waiting on N", it does not gate the others.
- **One household header, three surfaces: `"<house> Group N"`.** Applications,
  Residents, and Leases all collect housemates under a cluster header built by
  `src/lib/rental-application/group-house-label.ts`. Two rules make the number
  trustworthy, and both are easy to break by computing it locally:
  - **The ordinal is per house and numbered over EVERY row the surface holds**,
    never the current tab, bucket, search, or property filter — otherwise the
    same household renumbers as it moves Pending → Approved, or reads as
    "Group 1" on one tab and "Group 2" on the next. Ordinals are assigned over a
    sorted group id so they do not depend on row order.
  - **A group that spans houses anchors to its dominant property**
    (`dominantPropertyLabel`), because the strict "every row shares one property"
    rule (`householdClusterPropertyLabel`) returns null for a real split
    household and dropped the house from the header entirely. That strict rule
    still governs clusters with NO group — unrelated rows must not claim a
    shared house.

  A group with only one row present in the visible list is not a household and
  stays a plain row. Coverage: `tests/unit/group-house-label.test.ts`,
  `tests/unit/application-group-ui.test.tsx`.
- **Money-adjacent surfaces for bundle+group households.** When applicants apply as a
  group **and** select the same `bundleId`, move-in charges split equally across the
  declared household size (`src/lib/bundle-group/bundle-cost-split.ts` →
  `household-charges.ts`). Each member still has their own charge rows with split
  metadata; amounts are equal shares of bundle totals (deposit, utilities, rent,
  move-in fee). The applicant wizard is not the only writer of `bundleId` — a
  manager picks one directly on the add/edit resident form, which resolves the
  placement through `resolveManualResidentAssignment`
  (`src/lib/rental-application/placement-values.ts`) so a manual placement
  stores the same `application.bundleId` and prices off the same bundle totals.
  A bundle and a single room are mutually exclusive there, exactly as in the
  wizard.
- **Joint bundle lease.** When every member of a complete bundle group is approved,
  `lease-pipeline-storage.ts` creates one `leaseKind: "joint_bundle"` row (not one
  lease per person). All co-tenants appear on the lease document; the manager reviews
  and sends a single household lease. Per-member lease rows are suppressed for joint
  members.
- The listing-side `ManagerBundleRow` (grouped rooms at one price, applicant's
  `bundleId`) and group applications (`groupId`) are linked when both are present —
  use `src/lib/bundle-group/` for reconciliation, split math, and joint lease helpers.
