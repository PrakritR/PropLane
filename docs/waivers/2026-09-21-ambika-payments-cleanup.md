# Waiver: Ambika production payments cleanup (PLAN-0920-2357 stream D)

**Date:** 2026-09-21
**Captain approval:** Lavish PLAN-0920-2357 Decide answers + `approved — build`.

## Scope

One-shot script:

`scripts/cleanup-ambika-payments-production.ts`

Deletes, **only** under Ambika Mago (`ogambik2@gmail.com` /
`c49d02b1-7e99-4484-9986-b3b4550c3519`) on production (`qahnczmilgptcedaqype`):

1. **23 duplicate generated household charges.** The recurring-rent
   generator wrote a second `rent`/`utilities` charge on top of a row the
   sales-migration import already created (`row_data.migrationSourceId`)
   for the same property, resident, and rent month
   (`row_data.rentMonth`). Two of these duplicates were marked paid by
   hand; that does not exempt them — the imported row is the row of
   record. The script prints the paid duplicates separately, and prints
   separately again any duplicate that shows real settlement (a Stripe
   Checkout session on the charge or one of its ledger lines, or
   `paidMethod: "card"`); it refuses to apply while such a settled duplicate
   exists unless `ALLOW_PAID_DUPLICATE_DELETE=1`.
2. **Their ledger lines** — the `ledger_entries` rows whose
   `source_charge_id` points at one of the 23 duplicate charges: every line
   of an unpaid duplicate, but only the `charge` line of a paid duplicate.
   A paid duplicate's `payment` / `refund` lines are kept unless
   `ALLOW_PAID_DUPLICATE_DELETE=1`.
3. **342 ledger lines on exactly the three deleted seed properties**
   (`mgr-seed-4709a-8th-ave-ne`, `mgr-seed-5259-brooklyn-ave-ne`,
   `mgr--9-rooms-b1wf3z` — the `AMBIKA_DEAD_SEED_PROPERTY_IDS` allowlist).
   Those `manager_property_records` rows are gone; deleting a property row
   never removed the ledger lines that pointed at it. A ledger line with an
   empty or null `property_id` (a manual one-off charge filed under no
   property) is never selected.
4. **32 orphan October / late-fee ledger lines** on the live properties —
   `entry_type = "charge"` rows with `source_charge_id = null`, created
   since 2026-09-19, where the charge-delete path removed the charge row
   but left its ledger line behind.

What the same change fixes: the generator's migrated-month skip (root
cause 1 — `syncAllRecurringRentCharges` treats a migrated rent row for the
same resident/property/`rentMonth` as covering that month), the charge-delete
ledger cleanup (root cause 4 — `deleteLedgerEntriesForCharge` removes the
`charge` ledger line when a charge is deleted), and workbook-independent
sales-migration ids (so re-uploading a sheet is a no-op). **The property-delete
cascade is NOT changed** — deleting a property still leaves its ledger lines
behind; group 3 is a one-time sweep of the three known seed properties and
would recur if another property were deleted. This script clears the
accumulated mess; it does not fix the mess-making paths itself.

## Explicitly out of scope

- Any `manager_property_records` write or delete.
- Any charge row carrying `row_data.migrationSourceId` (an imported row is
  never a delete target, no matter how it is selected).
- The locked live listings (5257 / 5259 Brooklyn, 4709A 8th Ave) — this
  script never writes them; see `.cursor/rules/no-production-live-listings.mdc`.
- Other managers' portfolios.

## Backup

Apply first writes every row about to be deleted (full charge rows and
full ledger rows) as JSON to:

```
${AMBIKA_CLEANUP_BACKUP_DIR:-/Users/prakrit/Downloads}/ambika-payments-backup-<ISO timestamp>.json
```

The script verifies the file exists and parses before deleting anything.

## Apply gate

Dry-run is the default (no env flag, no `--apply`).

```bash
ALLOW_PRODUCTION_AMBIKA_PAYMENTS_CLEANUP=1 \
  npx tsx --env-file=.env.production.local \
    scripts/cleanup-ambika-payments-production.ts --apply
```

Add `ALLOW_PAID_DUPLICATE_DELETE=1` only after reviewing the "settled" and
"marked paid" duplicate lists the dry run prints.

## Ordering rule

**Apply this only after the recurring-rent generator fix (root cause 1)
is deployed to production.** If the cleanup runs first, the next portal load
that regenerates rent will simply regenerate the duplicate charges this script
just removed. The charge-delete ledger fix (root cause 4) should be live too so
group 4 stops growing; group 3 (the deleted seed properties) does not depend
on any deploy, since no property-delete code changed.
