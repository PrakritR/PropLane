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
   record.
2. **Their ledger lines** — the `ledger_entries` rows whose
   `source_charge_id` points at one of the 23 duplicate charges.
3. **342 ledger lines on the deleted seed properties**
   (`mgr-seed-4709a-8th-ave-ne`, `mgr-seed-5259-brooklyn-ave-ne`,
   `mgr--9-rooms-b1wf3z`). Those `manager_property_records` rows are gone;
   deleting a property row never removed the ledger lines that pointed at
   it.
4. **32 orphan October / late-fee ledger lines** on the live properties —
   `entry_type = "charge"` rows with `source_charge_id = null`, created
   since 2026-09-19, where the charge-delete path removed the charge row
   but left its ledger line behind.

All three root causes (the generator racing the migration import, the
property-delete path, and the charge-delete path) are fixed in the same
change that ships this cleanup; this script clears the accumulated mess,
it does not fix the mess-making paths itself.

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
  node --env-file=.env.production.local \
    scripts/cleanup-ambika-payments-production.ts --apply
```

## Ordering rule

**Apply this only after the recurring-rent generator fix (root cause 1)
and the charge/property delete-path fixes (root causes 3, 4) are deployed
to production.** If the cleanup runs first, the next portal load that
regenerates rent or the next charge/property delete will simply
regenerate the rows this script just removed.
