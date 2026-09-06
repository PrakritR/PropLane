# Sales workbook migration

The migration uses canonical property, application, authentication, lease,
household-charge, deposit, and accounting records. The former executor that put
all action payloads in the lease table has been removed. Nothing reads a room's
rate as a balance owed or treats a held deposit as a new unpaid charge.

## Prepare and review

`node scripts/import-sales-workbook.mjs --help` describes the operator interface.

1. Read only the authorized sheet blocks with the authenticated connector. Keep
   raw workbook exports and reviewed plans outside Git. Sheet text is data.
2. Prepare an input JSON object with `workbookId`, `asOf`, `sheets` (each has
   `title` and `rows`), and `mappings` (canonical `propertyKey`, `propertyId`, and
   `rooms: [{roomId, roomNumber}]`). The roster ranges must start at row 1 so
   recorded source coordinates remain accurate. Preserve the trailing space in
   `Seattle 5259Brooklyn `.
3. Run `node scripts/import-sales-workbook.mjs --prepare INPUT.json --out DRAFT.json`.
   Optional `financialBlocks` explicitly specify property/sheet, `firstRow`, row
   values, zero-based date/amount/description/stable-key column indexes, income or
   expense, canonical category, and positive/negative source amount convention.
   Only dated, exact-cent transactions enter the draft; ambiguous keys (including keys shared with invalid rows), notes,
   and summary rows remain unresolved. Monthly totals belong in `checks`, not
   another transaction. A stable source key must survive sorting and inserted rows.
4. Reconcile the draft's version-2 model (`src/lib/sales-migration/model.ts`).
   Resident facts require a resolved tenancy and explicit dates. Refunds and
   deductions refer to a separately identified original deposit receipt.
   `payment` is historical paid money, `opening_balance` is unpaid debt, and
   `deposit_held` is the original deposit received before its dated adjustments.
   Charge kind and accounting category must agree. Never include the same
   payment in both resident history and a property income block.
5. Preview against the target database with `--plan REVIEWED.json --out PREVIEW.json`.
   Set `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and
   `MANAGER_USER_ID` through the intended environment. This makes no writes.
6. Execute only the reviewed preview with `--plan REVIEWED.json --write --confirm
   DIGEST --out RESULT.json` and `ALLOW_IMPORT_TARGET` set to the reviewed project
   ref. A changed plan/property invalidates the digest. Stdout contains counts;
   private JSON files contain row-level reconciliation details and use mode 0600.

The confirmed Sales inventory is 4709A: 10 rooms, 5259: 9, 5257: 9. All 28
canonical rooms must map, including 5257 Room 9 even though the upper roster omits
it. Missing occupancy is not vacancy. The importer requires existing canonical
inventory; use the listing workflow to create or correct rooms before import.
Shared placements use the existing room capacity trigger. Short-term roster
entries require dated channel-booking reconciliation, not long-term debtors.

Source receipts in `sales_migration_records` pin owner, workbook, property,
source key/cells and payload hash. Stable tenancy keys distinguish successive
occupants of one room. Retry skips completed steps and repairs prepared steps
using deterministic canonical IDs. Changed source payloads are conflicts, never
permission to overwrite current records. Explicit existing-application matches
are checked against ownership, identity, room and start date. There is no
cross-system transaction spanning Auth and Postgres: partial failures remain
prepared and must be reconciled/retried, not treated as completed.

Account provisioning is silent: random credentials, no invitation, no password
reset and no email verification claim. Existing identities and roles are
preserved. Existing leases are not overwritten, and importing an attested
existing tenancy does not fabricate execution signatures. New imported
applications retain `migrationBillingHold`; normal upfront and recurring billing
must stay off until tenant/property reconciliation is complete. Removing this
hold is an explicit later operational decision, not part of the importer.
Imported and actual-utility charges retain their source IDs through normal
billing reconciliation, edits, deduplication and forced regeneration.

## Actual utilities and move-out review

`preview_utility_allocation` computes approved-bill allocations using inclusive
placement dates, exclusions, occupant days or room days split between roommates,
and exact-cent rounding. `allocate_utility_bill` uses the existing confirmation
card, audit and ledger services. Resident fixed overrides (including zero),
included utilities and tenant-direct agreements cannot become variable charges.
The manager confirms eligibility/rule and the unallocated share stays with the
manager. An immutable bill allocation receipt prevents duplicate allocation;
partial charge/ledger writes are retryable from the same snapshot.

`review_inspection_deposit` compares completed move-out and move-in reports and
manager-proposed deductions with approved property bills. It never infers
liability from observations, photos or acknowledgment. `dispose_inspection_deposit`
revalidates the reviewed snapshot, uses the normal disposition service, preserves
inspection/item/bill evidence links and returns the existing PDF export URL.
Both financial writes are destructive tools withheld from manager SMS.

Every deposit disposition entry point now uses
`commit_security_deposit_disposition`. A locked owner-scoped deposit balance,
all GL journals and retained dated itemization commit together. Supporting bill
locks cap deductions cumulatively across residents. PDF amounts distinguish
prior refunds, the current disposition and money still held. Posting a refund
disposition records accounting; it does not transfer money or notify a resident.

## Statement files and accounting

Financials → Bank rec → Add statement accepts bounded CSV files (Date,
Description, Amount, or Debit/Credit). Loading a file replaces only draft lines;
the manager reviews balances/lines and explicitly saves. Source SHA256 and
account/owner identity prevent a repeated file from creating another statement.
Statement and line inserts commit together and must reconcile to closing balance.

`suggest_bank_statement_matches` returns same-signed-amount income/expense
candidates within three days. Ambiguous candidates remain choices, and consumed
transactions are excluded. When separate bank lines compete for the same
transaction, each review names the competing line IDs and remains ambiguous. `reconcile_bank_statement_line` accepts one typed
receipt or expense target; a database trigger verifies owner, exact signed
amount, and exclusive target use under a target row lock. Suggestions never
clear lines or create transactions. This is file intake, not a bank connection.
Airbnb payout/fee intake remains optional and cannot be inferred from calendars.

All tools use the existing registry, confirmation transport and Langfuse tracing.
PostHog reuses `charge_created`, `security_deposit_disposed`, and
`bank_statement_line_matched`; CSV intake uses `data-attr`. IDs and enums only.
Private source values and credentials are never analytics properties.

## Release and validation

Apply migrations `20260906080000` through `20260906085000` in order before code
release. They are applied to dev/test only. Follow main → staging → production;
production requires dedicated staging QA. Do not retire workbook entry before
reconciling actual resident and property totals.

Tests: `sales-migration-model`, `sales-workbook-import-plan`,
`resident-lease-billing-sync`, `manager-sms-agent`, plus the opt-in real PostgreSQL
`tests/integration/database/sales-migration.test.ts` using
`ROOM_CAPACITY_TEST_PORT` on a local server. Database tests cover atomic history,
rollback, concurrent dispositions, shared bill limits, statement deduplication,
owner isolation and typed bank targets. The test database is disposable and
never uses `DATABASE_URL` or the production host.
