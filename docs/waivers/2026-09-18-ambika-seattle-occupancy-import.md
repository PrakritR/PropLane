# Waiver: Ambika Seattle occupancy import (PLAN-0918-1909)

**Date:** 2026-09-18  
**Captain approval:** Lavish PLAN-0918-1909 Decide answers + `approved — build`.

## Scope

One-shot script:

`scripts/import-ambika-seattle-occupancy-production.mjs`

Writes **only** under Ambika Mago (`ogambik2@gmail.com` /
`c49d02b1-7e99-4484-9986-b3b4550c3519`) on production
(`qahnczmilgptcedaqype`):

- Current-resident applications on her **copy** listing ids
  (`mgr-listing-1x3tiu0489ha`, `mgr-5257-brooklyn-ave-copy-9-rooms-7mbwr0uza0nq`,
  `mgr-5259-brooklyn-ave-copy-9-rooms-7mdlyj0h2vfg`)
- Signed off-platform lease PDFs when a file exists
- `--slim-payloads` on those same lease rows (drop inline PDF/HTML bytes from
  `row_data` so Residents can load)
- `--restore-documents` files the local signed PDFs into `manager_documents`
  and stamps `libraryDocumentId` on the slim lease rows
- Paid household charges from lease start through today; later months pending
- Airbnb / Vinod calendar stays as Bookings entries (no resident login)
- Setup-account email (real inbox) or SMS (sheet phone)

## Explicitly out of scope

- Any `manager_property_records` write, including listing advertised rent
- Locked seed listing ids (`mgr--9-rooms-b1wf3z`,
  `mgr-seed-5259-brooklyn-ave-ne`, `mgr-seed-4709a-8th-ave-ne`)
- Invented Gmail addresses
- HOA / gate / lockbox material from the sales workbook
- California workbook houses
- Onboard to Airbnb stays

## Apply gate

Dry-run is the default (no env flag, no `--apply`).

```bash
ALLOW_PRODUCTION_AMBIKA_SEATTLE_OCCUPANCY=1 \
  node --env-file=.env.production.local \
    scripts/import-ambika-seattle-occupancy-production.mjs --apply
```
