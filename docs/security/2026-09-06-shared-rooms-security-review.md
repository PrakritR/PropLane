# Shared rooms — security re-review

Reviewed: 2026-09-06T00:37:43.304044+00:00. Reviewer: security-review subagent.
Base and committed HEAD: `98eff6d3011a3f37b9c683f7fd3601cb4848da1d` (`98eff6d3`).
Scope: the uncommitted shared-room completion diff, including the new SQL migration,
public occupancy modules and transaction integration tests listed below. Inspection
changes are reviewed separately. No implementation code was edited by this reviewer;
the root authorized retaining this report and reusable integration evidence.

## Gate result

**No unresolved Critical or High findings in the reviewed shared-room diff.**
SR-07 was reproduced and then resolved with a server-owned occupancy-start floor.
The application billing dates can advance to renewal while the existing continuous
residency remains reserved. The transfer boundary and legacy application-ID normalization also preserve the
trusted occupancy floor correctly after re-review.

## Findings and resolution evidence

- **SR-01 / High / resolved:** Approval persistence lacked a capacity guard and local
  side effects ran first. Application publication now follows awaited single-row
  persistence. The database AFTER INSERT/UPDATE guard serializes approved placements
  on a real property revision UPDATE before a separate VOLATILE occupancy query.
  The independent-client test proves one last-bed winner after a verified lock wait;
  repeatable-read stale snapshots fail `40001`. Provisioning remains after the database
  write, and secondary profile-sync failure does not revoke the committed placement.
- **SR-02 / High / resolved for move-out amendments:** Extensions previously counted
  only signed leases and committed application/lease dates separately. Preview reads
  approved applications; `commit_room_lease_extension` binds expected snapshots and
  owner/property/application identity and commits both records together. Integration
  evidence proves refusal leaves both original dates intact and success updates both.
  Browser-facing roles cannot execute the service-only RPC.
- **SR-03 / High / resolved:** The public route no longer exports application IDs,
  residents, or one row per personal lease. It returns anonymous aggregated occupancy
  spans, limited to the public listing catalog and matching owner. Date/count changes
  necessarily reveal aggregate availability; this is not claimed to hide occupancy
  change dates for a singly occupied room. No peer documents or identity fields are
  returned. The API selects only occupancy projections, not the encrypted applicant blob.
- **SR-04 / Medium / resolved:** The old global 500-row cap and stale union merge are
  removed. Pagination iterates each canonical JSON property path. Whole-property
  bookings consume every room's capacity. The client replaces the aggregate snapshot,
  expires it after 60 seconds, clears it on private cache events/scope changes and ignores
  it in demo. The API uses owner checks after canonical property resolution.
- **SR-05 / Medium / resolved:** BEFORE INSERT rejected metadata UPSERTs before their
  ON CONFLICT UPDATE could reach the unchanged-placement exemption. Changed to AFTER
  INSERT/UPDATE. Local PostgreSQL reproduction originally returned `P4001` for a pure
  metadata UPSERT after a maintenance block; retained test now passes. Property fallback
  edits watch both property_data and row_data with the same coalesced submission source.
- **SR-06 / High / resolved except SR-07:** Signed renewal completion could leave a
  signed promise and rewritten charges after an application placement refusal. A
  database final-signature trigger now writes application placement in the signature
  transaction; a refused bed rolls the signature back. Empty signature objects do not
  finalize renewal. The browser awaits application persistence before billing and
  selects the exact application rather than an earlier row sharing the email.
- **SR-07 / High / resolved:** Final renewal signing previously discarded the original
  committed interval, allowing an Oct15–20 placement after an Oct1–31 resident signed
  a Nov1 renewal. The `occupancy_start` database column now retains the original
  continuous-residency start; the evaluator uses the earlier trusted floor while
  application/lease billing dates advance. SQL injects the column over any similarly
  named row_data field, so client input cannot override enforcement. The retained
  regression now passes. Public occupancy and extension preview project the same floor.
- **SR-08 / Medium / resolved:** A floor carried to a different room could wrongly
  reserve the destination back to the original room's start. The BEFORE UPDATE reset
  trigger clears it when owner/property/canonical room changes and preserves it for
  equivalent room aliases. Both transfer and alias behavior pass real PostgreSQL tests.
- **SR-09 / High / resolved during review:** Legacy ID normalization originally
  copied only pre-existing columns, dropping the newly introduced occupancy floor
  when it inserted the canonical row and deleted the original. The later migration
  recreates the normalization RPC and copies `old_row.occupancy_start` inside its
  existing transaction. Existing identity-snapshot checks and child/alias updates are
  retained. A real SQL test normalizes a renewed legacy record and proves the original
  interval stays unavailable afterward.

## Verification

Command:

```sh
ROOM_CAPACITY_TEST_PORT=55439 npx vitest run tests/integration/database/shared-room-capacity.test.ts
```

Latest result: **12 PostgreSQL tests passed**, including the previously failing
old-interval regression. A combined run with five existing occupancy/roommate suites
passed **77 tests across six files**. The suite creates a randomly named database on an
explicit loopback PostgreSQL test port, executes the real migration against minimal
matching table schemas and drops only its own database. It never drops the caller's
schema/database, reads DATABASE_URL, or connects to hosted Supabase. Existing Supabase
roles must be present; the test creates no cluster roles.

Retained cases cover a verified two-client lock wait, stale repeatable-read snapshot,
capacity decrease, disjoint stays with a spanning resident, metadata UPSERT, atomic
extension refusal/success, signed-renewal refusal, empty signatures and successful
renewal reservation, room transfer/equivalent aliases, and legacy ID normalization.
The earlier SR-07 failure and its resolution were both reproduced against real
PostgreSQL, not a mock.

`npx eslint tests/integration/database/shared-room-capacity.test.ts` passed on the
final 12-case test file. The root owns final full lint/unit/ship checks.
This review does not claim deployed database migration or browser QA.

## Concurrency reasoning

The property revision is updated, not merely advisory-locked. READ COMMITTED executes
the subsequent volatile occupancy query against a fresh snapshot after the wait.
REPEATABLE READ rejects a revision updated since its snapshot. AFTER-row checking
excludes the candidate's canonical application identity before adding it once.
App/lease/property lock-order differences can produce `40P01`; the losing transaction
rolls back and the route returns a retryable conflict, preserving occupancy correctness.
Do not blindly replay stale whole-row input after a conflict.

PostgreSQL references: [transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html),
[function volatility](https://www.postgresql.org/docs/current/xfunc-volatility.html).

## Reviewed working-tree fingerprints

Final re-review at 2026-09-06T00:42:58.222806+00:00.
These hashes identify the reviewed uncommitted contents; later changes require a
resolution addendum rather than treating this document as an unchanged-head approval.

- `supabase/migrations/20260906070000_shared_room_capacity.sql` — SHA-256 `31a7dc91a843bab10d0e7b63c391c9280d67fa591f173f73c5df13f3d2ac8941`
- `src/lib/application-review.ts` — SHA-256 `0632f431cdaf7500ff62b0d35a33e8c891fcf7025cb9cc4c1bf95ff869846ee1`
- `src/app/api/manager-applications/route.ts` — SHA-256 `7d00a81393c4570eabb7dcf9fd3adff6d0532797dc29436e843241e5896804aa`
- `src/lib/lease-amendment.server.ts` — SHA-256 `b094daeaf8ee2467edd9495cfc8528093b53698dee20fce2dec65f69373bbd90`
- `src/lib/lease-renewal-payments.ts` — SHA-256 `ac21735f5261cc7985aac2ee07669aa21005576b77a02db5712b3e06a9c277da`
- `src/components/portal/pro-leases-pipeline-panel.tsx` — SHA-256 `f9a0c92db737b7d2385564e648f7bfafefd2edcd669119bf1583b66652b8095d`
- `src/app/api/public/approved-room-occupancy/route.ts` — SHA-256 `da71fce0d35f2ee89abfd4fb48f9e9344fe98df814213a002ab48509ad8968fd`
- `src/lib/public-room-occupancy.ts` — SHA-256 `6e53b69413a134597f8ae8ff5f833c019e0282ca5fd4ef77dda6cdc8e7a86874`
- `src/lib/public-room-occupancy-client.ts` — SHA-256 `dff743de10356e0654b18f7d7f31c51172568fd4dbdad5f9e2948c2af55efa55`
- `src/lib/manager-applications-storage.ts` — SHA-256 `2c8274917ed84a1847461f272425046ac45a59f85e49cc5e39c4af5a862e669c`
- `src/lib/rental-application/data.ts` — SHA-256 `f9f62aeae968db66247c01863ccad182fe7cde2259b0cab7606932658257d37e`
- `tests/integration/database/shared-room-capacity.test.ts` — SHA-256 `5f1bfff070624563eb2b3b02c44c5f96f7e02788f62adf26a2054fcab4995582`
