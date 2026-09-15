# Portfolio import (spreadsheet / AppFolio / Buildium export / rent-roll PDF)

A manager switching to PropLane uploads a rent roll and gets properties, units,
residents, opening balances and follow-up tasks created together, then invites
the residents. Read this before touching `src/lib/portfolio-import/`,
`src/app/api/portal/portfolio-import/`, the wizard components, or the
`*_portfolio_import*` agent tools.

## Shape

```
Properties tab (empty state · ＋ menu · ADD footer)
Dashboard (import icon beside ＋)            ──►  POST /api/portal/portfolio-import
Ask PropLane (.csv/.xlsx/.pdf attachment)   ──►  (one draft row per upload)
                                                       │
                     readSpreadsheetTable / readPdfRentRollTable   → PortfolioImportSourceTable
                     mapPortfolioImportHeaders (+ AI only for unknown headers)
                     buildPortfolioImportDraft                        → PortfolioImportDraft
                                                       │
                     review (wizard step 3 / assistant confirm card)
                                                       │
                     commitPortfolioImport  → manager_property_records (unlisted)
                                              manager_application_records + lease row
                                              household charge (opening balance)
                                              manager tasks (templateKey "import:*")
                                                       │
                     invitePortfolioImportResidents → welcome email + welcome text
```

| Piece | File |
| --- | --- |
| Draft contract (every entry point shares it) | `src/lib/portfolio-import/types.ts` |
| Header dictionary + presets, manual override | `src/lib/portfolio-import/column-map.ts` |
| csv / xlsx readers | `src/lib/portfolio-import/spreadsheet.server.ts` |
| PDF rent roll (unpdf + model extraction) | `src/lib/portfolio-import/pdf-rent-roll.server.ts` |
| AI mapping of unknown headers only | `src/lib/portfolio-import/column-map-ai.server.ts` |
| Rows → properties / units / residents / issues / tasks | `src/lib/portfolio-import/build-draft.ts` |
| Store + receipts | `src/lib/portfolio-import/store.server.ts` |
| Commit (idempotent) / invites | `src/lib/portfolio-import/commit.server.ts`, `invite.server.ts` |
| Routes | `src/app/api/portal/portfolio-import/**` |
| Wizard page | `/portal/properties/import`, `src/components/portal/portfolio-import-wizard.tsx` |
| Agent tools | `src/lib/tools/domains/portfolio-import.ts` |
| Tables | `manager_portfolio_imports`, `manager_portfolio_import_records` (`20260915000000`) |

## Invariants

- **One draft model.** The wizard and the assistant read and commit the same
  `manager_portfolio_imports.draft`. Counts on every screen and in every tool
  preview come from `summarizePortfolioImportDraft`, never from a model.
- **The model never sees row data when mapping columns.** Deterministic
  synonyms first; `mapUnknownHeadersWithAi` gets only the unmatched header names
  and three sample cells and returns a mapping. "Deposit" and "Market Rent" can
  never map to rent (`portfolio-import-column-map.test.ts`).
- **A `block` issue stops the commit; a `review` issue never does.** Excluding
  the row or fixing the field clears it (`recomputeDraftAfterEdits`). PDF rows
  carry a `pdf_verify` review issue and each property gets a "Verify imported
  data" task.
- **Imported properties are `unlisted`.** Private, no admin review, and not in
  `LISTING_SLOT_PROPERTY_STATUSES`, so an import is never blocked by the plan
  limit. Listing one later goes through the normal quota gate.
- **Commit is idempotent through receipts.** One
  `manager_portfolio_import_records` row per planned record
  (`unique (import_id, record_kind, source_key)`); a re-run skips completed
  receipts and retries prepared ones. Partial failures stay partial and are
  named on the wizard's Import step; nothing is ever created twice.
- **Residents are manager-attested tenancies**, built with the same
  application-row builder the Residents tab's "Add resident" uses
  (`src/lib/resident-document-import/build-application-row.ts`) and onboarded
  through `runExistingResidentOnboarding` with `sendWelcomeEmail: false`. A
  fully executed lease PDF attached in review makes the lease row `signed`;
  otherwise the lease waits in Leases → Manager.
- **Invites are explicit.** Nothing is emailed or texted on commit. Step 5 (or
  `invite_imported_residents`) sends the existing welcome email and the welcome
  text from the workspace work number; no work number → email only, and the
  wizard offers the Settings → Messaging setup inline. The phone comes from the
  imported row, never from `profiles`.
- **Same file twice → 409 with the existing import id** (sha256 unique index
  while not discarded).
- **Caps.** 5 MB, 2,000 rows (`PORTFOLIO_IMPORT_MAX_BYTES/ROWS`); parsing is
  synchronous inside one request, the commit resumes across requests.
- **PII.** The draft holds names, emails and phones: owner RLS, client roles
  SELECT-only, both tables classified in `account-purge-manifest.ts`.

## Analytics

PostHog `portfolio_import_started` {source}, `portfolio_import_committed`
{source, propertyCount, unitCount, residentCount, taskCount},
`portfolio_import_invites_sent` {emailCount, textCount}; `data-attr` on every
wizard control. No file names, no emails. Model calls are Langfuse-traced with
`landlordId`.

## Fixtures

`tests/fixtures/portfolio-import/` carries one data set in every shape
(AppFolio csv, Buildium xlsx, generic csv, rent-roll pdf, a text-less scan):
Maple Court (4 units, one shared by two tenants, one vacant, one past-due) and
1412 Pine St (3 rooms, one resident with a phone but no email). Expected draft:
2 properties, 7 units, 6 residents, 1 balance, 1 block issue, 11 tasks.
