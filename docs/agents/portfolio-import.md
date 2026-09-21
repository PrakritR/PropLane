# Portfolio import (rebuilt): spreadsheet / rent roll / PDF → properties, residents, leases, charges, tasks

A manager switching to PropLane uploads whatever files they have — a rent
roll, an owner's own sheet, an AppFolio or Buildium export, PDFs — at
`/portal/properties/import`, reviews ONE proposal covering everything the
files describe, and creates it. Read this before touching
`src/lib/portfolio-import/`, `src/app/api/portal/portfolio-import/`, or
`src/lib/tools/domains/portfolio-import.ts`.

The property/room side of this (`src/lib/property-import/`) is unchanged and
still the read `submissionFromImportedProperty` builds a draft from — see its
own section below. This rebuild adds a SECOND model pass for who lives where
today, merges both into one proposal, and creates everything (not just
listing drafts) through the real per-domain creation paths.

## Shape

```
/portal/properties/import  (Upload → Review → Create)
        │
   POST /api/portal/portfolio-import  { files[] (1-50, ≤5MB each), hint? }
        │   read-file.server (unchanged)     → row-numbered cell grids per file
        │   understand.server (unchanged)    → properties + rooms (ONE model call, report_properties)
        │   understand-residents.server      → current residents (ONE model call, report_residents)
        │   propose.ts                       → merges both into a PortfolioImportProposal (pure)
        │   store.server                     → persists it under a fresh importId
        │
   GET  /api/portal/portfolio-import/[importId]           → the stored proposal
   PATCH .../[importId]  { answers?, skips? }              → merge gap answers / skip an item, recomputes status
        │
   POST .../[importId]/create  { sendInvites, answers?, skips? }
        │   create.server.ts — ONE property at a time, through the real paths:
        │     rooms/property  → submissionFromImportedProperty → the SAME draft row
        │                        saveManagerPropertyDraftToServer would build
        │                        (its two pure builders, exported, called directly —
        │                        that function itself is browser-only) → manager_property_records, status "draft"
        │     residents       → buildImportedResidentRow → manager_application_records
        │                        → provisionApprovedResidentAccount (auth account)
        │                        → runExistingResidentOnboarding (lease stub + optional welcome)
        │     leases          → created BY runExistingResidentOnboarding: no attached signed
        │                        document → a "manager" bucket lease with managerAttestedTenancyAt,
        │                        genuinely unsigned
        │     charges         → a HouseholdCharge row → portal_household_charge_records
        │                        → syncLedgerChargeEntry (write-through ledger sync)
        │     tasks           → createManagerTaskRow
        │   A property that throws is unwound (best-effort compensating deletes of
        │   what THIS attempt created) and reported in `failures[]`; other properties
        │   are unaffected.
        │
   portfolio_import_status (agent tool, manager PORTAL only) → the stored proposal's
        summary + unresolved gaps, for "how did my import go"
```

| Piece | File |
| --- | --- |
| Shared types (the review UI and the server agree on exactly this) | `src/lib/portfolio-import/types.ts` |
| Resident model pass | `src/lib/portfolio-import/understand-residents.server.ts` |
| Pure merge into one proposal | `src/lib/portfolio-import/propose.ts` |
| Persistence (`manager_portfolio_import*` tables) | `src/lib/portfolio-import/store.server.ts` |
| Creation through the real paths | `src/lib/portfolio-import/create.server.ts` |
| Placeholder email convention | `src/lib/portfolio-import/placeholder-email.ts` |
| Routes | `src/app/api/portal/portfolio-import/route.ts` (upload), `.../[importId]/route.ts` (GET/PATCH), `.../[importId]/create/route.ts` |
| Agent tool (read-only, portal only) | `src/lib/tools/domains/portfolio-import.ts` (`portfolio_import_status`) |
| Property/room read (unchanged) | `src/lib/property-import/read-file.server.ts`, `understand.server.ts`, `to-submission.ts` |

## Invariants

- **Two model passes over the SAME grids, never a re-read.** Both
  `understandPropertyImport` (properties/rooms) and `understandResidents`
  (current residents) consume the identical row-numbered cell grids from
  `read-file.server.ts`, each answering through exactly one forced tool call.
  Neither reads the file twice.
- **Rent is what the tenant pays.** Market/asking rent, deposit, and
  balance/arrears never become rent — enforced in both model prompts and
  re-validated when the payload is parsed.
- **Every proposal item cites its file/sheet/rows or pdf page** (`ImportSource`
  on every property, room, resident, charge, and task).
- **A "needs" item never gets created silently.** `create.server.ts` refuses
  a whole property if any of its (non-skipped) residents still has an
  unresolved gap after merging the manager's `answers`/`skips` — it does not
  create the property half-answered. The manager answers the gap or skips
  that resident first (`PATCH .../[importId]`).
- **Nothing is fabricated as a signature.** An imported resident's lease is
  created unsigned; `runExistingResidentOnboarding` sets
  `managerAttestedTenancyAt` (establishes tenancy, not a signature) rather
  than inventing manager/resident signatures. Every imported resident
  therefore also gets an `unsigned_lease` task.
- **Invites only on explicit opt-in.** `sendInvites` on the create request is
  the only thing that turns on `runExistingResidentOnboarding`'s welcome
  email/SMS; the default is off.
- **Money is whole dollars in this module.** `types.ts`'s money fields match
  `src/lib/property-import/types.ts`'s convention; a persisting write (a
  `HouseholdCharge`'s `amountLabel`, the ledger's `amount_cents`) converts at
  its own boundary, same as every other charge-creation path.
- **Creation reuses the real paths, never a second one.** Listing drafts,
  resident onboarding, the household-charge ledger sync, and manager tasks
  are all the SAME functions every other entry point calls — see the table
  above. `create.server.ts`'s own header comment explains exactly which
  pieces are direct service-role writes (mirroring `create_property` and
  every other server-side write tool, which never `fetch()` an internal
  route) versus calls into existing shared functions.
- **Per-property rollback, not a database transaction.** ids inside one
  property (the draft, the resident row, each charge) are deterministic
  (`shortHash(importId + proposal key)`), so re-running `create()` after a
  partial failure upserts the same rows rather than duplicating them. A
  property that throws partway is unwound with best-effort compensating
  deletes of what that attempt created before moving to the next property.
  Manager tasks are stored one JSON array per manager
  (`manager-tasks.server.ts`) and `createManagerTaskRow` always appends
  rather than upserting by id, so `create.server.ts` guards retry-safety
  itself: every import task gets a deterministic id
  (`task_import_<shortHash(task key)>`, same convention as charges), loaded
  once per `create()` call against this manager's current tasks, and skipped
  when that id is already present — a literal retry of the same `create()`
  call never duplicates a task (or a property, resident, or charge, which
  were already deterministic upserts).
- **A room skip is a real server-side skip.** `PortfolioImportUpdateRequest`/
  `PortfolioImportCreateRequest`'s `skips` accepts a property key, a resident
  key, OR a room key. `applyAnswersAndSkips` drops a skipped room from
  `property.rooms` entirely (defensively, only when no resident is tied to
  it), so it is never created as an unoccupied room in the draft. The review
  screen's `EmptyRoomRow` "Skip" button (only ever shown for a room no
  resident occupies) round-trips through the same `PATCH` a resident skip
  does — never local-only UI state.
- **Caps.** 50 files per upload, 5 MB each, 8 uploads/minute/manager (same
  budget as `property-import/read`). Under `NODE_ENV=test` or without
  `ANTHROPIC_API_KEY` both model passes refuse rather than inventing a
  portfolio.
- **Untrusted input.** Sheet text is data; the manager's hint is the only
  instruction either pass follows. Both traced with `landlordId`.
- **The agent tool is portal-only.** `portfolio_import_status` is withheld
  from manager SMS (`MANAGER_PORTAL_ONLY_TOOLS` in `src/lib/tools/index.ts`)
  because the review screen it answers about doesn't exist there. It is
  read-only — there is no `portfolio_import_create` tool; creation stays a
  page action the manager explicitly takes, same as approving an application
  isn't an agent tool either.

## What changed from the pre-rebuild version

The version removed in commit `8302fa69` ("chore(import): remove the
portfolio import until it is rebuilt") parsed a rent roll by matching its own
header row against a canonical column list (`column-map.ts` / `build-draft.ts`).
That never produced a usable draft from a real spreadsheet — no layout
consistently matched. This rebuild replaces the whole read with two model
passes over the raw grid (exactly how `property-import`'s property/room read
already works), and only reuses the pre-rebuild code that had nothing to do
with header matching: the placeholder-email convention, and the receipt
(prepare/complete/fail) persistence shape in `store.server.ts`, itself
unchanged from `sales-migration`'s pattern.

The `manager_portfolio_import*` tables survived the removal and are reused
here, widened additively (`20260920240000_portfolio_import_rebuild.sql`) to
accept a multi-file upload instead of exactly one file per row. The stored
`draft` jsonb column now holds `{version: 2, proposal}` (the rebuilt
`PortfolioImportProposal`); a pre-rebuild `{version: 1, table, draft}` row, if
one somehow still existed, is never read as a proposal.

## Fixtures

`tests/fixtures/portfolio-import/`: `appfolio-rent-roll.csv`,
`buildium-rent-roll.xlsx`, `generic.csv`, `owner-messy.xlsx` (title rows,
merged header, blank spacers, Market Rent beside Rent, totals rows, three
tabs), `rent-roll.pdf`, `scan-no-text.pdf` (text-less scan — exercises the
unreadable-PDF refusal). See `docs/agents/portfolio-import.md`'s git history
for the last recorded live-read results against these fixtures for the
property/room pass; the resident pass has not yet been proven against them
live (see the AREA 5 build handoff for what still needs a live pass).
