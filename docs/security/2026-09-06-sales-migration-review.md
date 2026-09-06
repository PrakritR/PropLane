# Sales migration integration review — 2026-09-06 UTC

Scope: canonical workbook migration integrated with shared placements,
actual-utility billing, inspections/deposits, and statement file matching.

Security and bugbot reviewers independently reviewed the implementation.
Findings fixed before this record:

- Canonical application IDs exist before persistence; source charges cannot be
  collapsed or deleted by automatic billing reconciliation.
- Silent account provisioning preserves existing identities and fails closed
  on profile lookup errors. New imported tenancies keep automatic billing held.
- Property inventory must match existing canonical rooms; no incomplete listing
  rooms or occupancy facts are manufactured from missing roster rows.
- Utility allocations preserve resident fixed terms, including an explicit zero.
- Deposit balance changes, GL journals, cumulative itemization and supporting
  bill consumption share one owner-scoped locked transaction. Prior history
  survives ordinary and inspection-driven dispositions.
- PDF refunds exclude undisposed held funds and retain prior deductions.
- Bank matches support typed expense targets; owner, signed amount and exclusive
  target consumption are enforced for every writer under a database row lock.

Validation:

- Full `npm run test:unit`: **8,017 passed in 1,192 files**. Subsequent focused
  suites after adding explicit financial-block preparation: **42 passed**.
- Real local PostgreSQL integration: **8 passed**, including rollback,
  concurrent shared bill claims, owner isolation and statement deduplication.
- TypeScript and production build passed. Changed-file ESLint: no errors or
  warnings. Ship preflight returned PASS (7 checks, 3 warnings): uncommitted
  tree, unpopulated ambient shell environment, and skipped Langfuse regression.
  This preflight did not verify the Vercel Production environment.
- Dev/test-only canonical fixture: one shared-capacity property, one existing
  tenancy, historical paid rent, unpaid opening balance, original held deposit,
  dated refund/deduction, property income/expense. First run completed eight
  source steps; second run skipped all eight without duplicate records.
- Same fixture: approved utility bill → reviewed allocation → repeat skipped;
  explicit-zero resident utility override rejected an additional allocation.
- Completed move-in baseline → observed move-out → resident acknowledgment →
  manager completion → approved repair bill → reviewed deposit disposition.
  Original $600, prior $100 refund/$50 deduction, new $100 deduction:
  final refund disposition $350, remaining held $0, all four history lines kept.
- CSV intake matched both income and expense transactions, then excluded the
  consumed transactions. Authenticated 390px browser: file preview, explicit
  save, no horizontal overflow or runtime errors, deposit PDF download passed.
  Browser portal selection used the normal authenticated set-active-portal API
  because the unrelated chooser remained on Loading in this test session.

Only the shared dev/test database received these migrations or fixture writes.
The actual Sales draft preserves all 28 physical rooms and has 51 unresolved
source issues; none of its real residents or financial facts was imported.
Missing emails, lease starts, 5257 Room 3 end/M2M, Room 9 occupancy, and historical
account/deposit reconciliation require source review. Short-term bookings and
optional Airbnb payout intake are not inferred from occupancy calendars.

Release remains subject to the existing no-mistakes gate decisions and the
main → staging → production ladder. This record is not production QA sign-off.
