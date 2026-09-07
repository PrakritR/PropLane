# Waiver: Ambika orphan resident cleanup (PRP-406)

**Date:** 2026-09-07  
**Ticket:** [PRP-406](https://linear.app/axishousing/issue/PRP-406/when-a-resident-is-deleted-from-a-manager-account-also-delete-payments)  
**Captain approval:** chat `BUILD` on the PRP-406 Lavish plan (includes production orphan cleanup).

## Scope

One-shot script:

`scripts/cleanup-ambika-orphan-resident-data-production.mjs`

Deletes **only** orphan child rows (charges, rent profiles, leases, ledger,
reminders with `recipient_role=resident`, scheduled inbox, inbox threads) for
named emails under Ambika Mago (`ogambik2@gmail.com` /
`c49d02b1-7e99-4484-9986-b3b4550c3519`) that no longer have an application row.

## Explicitly out of scope

- Any `manager_property_records` write (including live Brooklyn / 4709A listings)
- `@import.proplane.local` occupancy / Airbnb placeholders
- Manager-role task reminders (e.g. to co-managers)
- Other managers’ portfolios

## Apply gate

```bash
ALLOW_PRODUCTION_AMBIKA_ORPHAN_CLEANUP=1 \
  node --env-file=.env.production.local \
  scripts/cleanup-ambika-orphan-resident-data-production.mjs --apply
```

Dry-run is the default (no env flag, no `--apply`).
