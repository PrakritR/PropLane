# Property import (spreadsheet / rent roll / PDF → listing drafts)

A manager switching to PropLane uploads whatever file they have — a rent
roll, an owner's own sheet, an AppFolio or Buildium export, a PDF — and gets
one listing draft per property, rooms and rents filled in, inside the Add
property workspace. Read this before touching `src/lib/property-import/`,
`src/app/api/portal/property-import/`, or
`src/components/portal/listing-wizard-v2/import-*.tsx`.

## Shape

```
Properties → ＋ → Import properties            (pro-properties.tsx, ImportWorkspace)
        │
   Upload step (import-upload-step.tsx)  ──►  POST /api/portal/property-import/read  {file, hint?}
        │                                          read-file.server   → row-numbered cell grids (no interpretation)
        │                                          understand.server  → ONE complex-tier model call, tool-use schema
        │                                          ◄── PropertyImportUnderstanding (properties, rooms, rows cited, notes)
        │
   Found list: one row per property, ⋯ Open / Merge into… / Not a property, hint + Re-read
        │
   each property → submissionFromImportedProperty (to-submission.ts) → saveManagerPropertyDraftToServer
        │            (the SAME draft path Add property uses; ✦ Imported marks via prefill.source = "file")
        │
   Basics → Rooms → Bathrooms → Shared spaces → Pricing → Review  (ListingWizardV2 with leadingStep + headerCenter)
            header switcher "1 of 6 · 400 Pike St ▾" moves between drafts; switching flushes first (flushRef)
```

| Piece | File |
| --- | --- |
| Types (isomorphic) | `src/lib/property-import/types.ts` |
| File → cell grids, caps | `src/lib/property-import/read-file.server.ts` |
| Whole-file model read, payload validation | `src/lib/property-import/understand.server.ts` |
| Understood property → listing draft | `src/lib/property-import/to-submission.ts` |
| Route | `src/app/api/portal/property-import/read/route.ts` |
| Workspace, Upload step, switcher | `src/components/portal/listing-wizard-v2/import-workspace.tsx`, `import-upload-step.tsx`, `import-property-switcher.tsx` |
| Editor hooks the import uses | `ListingEditorV2` `leadingStep` / `headerCenter`; `ListingWizardV2` `flushRef` |
| Live proof (dev only) | `scripts/testing/property-import-live-read.mts` |

## Invariants

- **The drafts are the import.** Nothing is stored server-side by the read;
  every found property is written as an ordinary listing draft the moment the
  read lands, through the same save path Add property uses. The Drafts tab
  is the resume point; there is no import record, banner or separate page.
  (`manager_portfolio_import*` tables remain from the previous import, unused.)
- **The model reads everything, and only answers through the tool.** Every
  kept row of every sheet, row-numbered, goes to `TIER_MODELS.complex` with
  `tool_choice` forced to `report_properties`; the input schema is the shape
  we read. `parseUnderstandingPayload` re-validates it (money, counts, rows,
  enums) — `property-import-understand.test.ts`.
- **Rent is what the tenant pays.** Market/asking rent, deposit, balance and
  arrears never become rent (prompt + fixture). Totals, subtotal and header
  rows are never properties. Resident names are out of scope for this read.
- **Rows are cited.** Every property and room carries the sheet and the
  file's own row numbers; the UI shows "rows 4–7".
- **A building whose units each carry a rent is priced by the room**
  (`shared_home`), so no unit price is lost — PropLane's rooms are its
  rentable units (`property-import-to-submission.test.ts`).
- **Add property is untouched.** `leadingStep` and `headerCenter` are
  optional; without them the six-step rail renders exactly as before
  (`listing-wizard-v2-leading-step.test.tsx`). The plan limit is the
  existing pre-check plus the server's own refusal on each draft save.
- **Caps.** 5 MB, 2,000 rows across sheets (the reader names the sheet it
  cut), 60 properties, 8 reads / minute / manager. Under `NODE_ENV=test` or
  without `ANTHROPIC_API_KEY` the read refuses rather than inventing a
  portfolio.
- **Untrusted input.** Sheet text is data; the manager's hint is the only
  instruction the model follows. Langfuse-traced with `landlordId`.

## Analytics

PostHog `property_import_read` / `property_import_reread` {sourceKind,
sheets, rowsRead, propertyCount, roomCount, needsLookCount, withHint} on the
server; `property_import_opened` {propertyCount} on the client. No file
names, no addresses. `data-attr` on every control (`import-*`).

## Fixtures

`tests/fixtures/portfolio-import/`: AppFolio csv, Buildium xlsx, generic csv,
rent-roll pdf, a text-less scan, and `owner-messy.xlsx` (title rows, merged
header, blank spacers, Market Rent beside Rent, totals rows, three tabs;
`scripts/testing/generate-owner-messy-fixture.mjs`). Live results on
2026-09-15: owner-messy → 4 properties / 9 rooms; buildium, appfolio, pdf →
2 properties / 7 units each, totals and Market Rent skipped, rows cited.
