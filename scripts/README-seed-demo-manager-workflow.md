# Seed: end-to-end manager workflow (`seed-demo-manager-workflow.mjs`)

Populates ONE coherent, relationship-consistent dev dataset for the canonical
test manager **`manager@test.proplane.local`** so every stage of the manager
pipeline is exercisable for intensive testing. The same axis-test Supabase DB
backs the website and the iOS/Android (Capacitor) apps, so this populates both.

## Run

```bash
# from the repo root, with axis-test service-role creds
node --env-file=.env.test scripts/seed-demo-manager-workflow.mjs
# or, if your .env holds axis-test creds:
node --env-file=.env      scripts/seed-demo-manager-workflow.mjs
```

Requires `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (service role).
**Point this only at the dev/test project, never production.**

Idempotent: every row is deterministically keyed (prefix `seedwf_`) and upserted,
so re-running updates in place — it does not duplicate. It only touches rows
owned by the target manager and the resident accounts it provisions; other
managers' data is left alone.

Optional overrides: `SEED_MANAGER_EMAIL`, `SEED_MANAGER_PASSWORD`.

## What it creates (all scoped to `manager@test.proplane.local`)

| Area | Rows | Notes |
|------|------|-------|
| Properties | 8 | Listed (`live`) ×3, `review` ×1, Pending ×2, Unlisted ×1, Rejected ×1 — every Property tab populates |
| Applications | 14 | Fully-filled `manager_application_records`: Approved ×8, Pending ×4, Rejected ×2 |
| Residents | 8 | Approved applicants promoted to resident accounts (profiles + `profile_roles` role=resident). Current ×6, Previous ×2 (moved-out) |
| Leases | 8 | Generated from approved apps, one per pipeline stage: **Manager review, Admin review, Resident signature pending, Manager signature pending, Signed** (Signed ×4) |
| Recurring rent | 4 | Active for current signed residents, inactive for previous |
| Payments (charges) | 41 | Pending / Overdue / Paid, incl. edge cases (overdue rent+late fee, a partial payment) |
| Income (ledger) | 73 | `ledger_entries` derived from PAID charges (32 income/payment rows) |
| Expenses | 13 | `manager_expense_entries` across 10 categories over the year |

## How the chain links together (app → lease → payment → finances)

- Each **lease** carries `axisId = <applicationId>` and the same `propertyId` /
  `resident_email` as its approved application — the lease is generated *from*
  the application.
- Each **charge** carries `applicationId = <applicationId>`, `propertyId`, and
  `residentEmail`, tying payment → resident → property → lease.
- Each PAID charge produces a `ledger_entries` payment row
  (`source_charge_id = <chargeId>`, `lease_id = <applicationId>`), so **Finances
  income is derived from real payments**. Expenses are property-scoped.

## Bucketing / filter notes (so seeded data sorts correctly)

- **Payments**: overdue = unpaid + due date in the past; pending is only shown
  when due within 7 days (seeded pending charges are due in the next few days);
  paid always shows. Dates are relative to run time, so buckets stay correct.
- **Finances**: default date range is Jan 1 (current year) → today. Seeded
  `posted_date` / `expense_date` are ISO dates within that range so totals,
  sorting, and property/resident/category filters are meaningfully testable.

## Related fix shipped alongside

The Finances panel could hang on **"Loading entries…"** because
`/api/reports/[reportId]?backfill=1` awaited a serial per-charge ledger backfill
(SELECT + INSERT/UPDATE per charge) before returning. Under volume that N+1
could exceed the request budget and never settle. `src/lib/reports/ledger-sync.ts`
now bulk-fetches existing entries once and does batched insert/upsert
(~3 round-trips regardless of charge count). (Since then the `?backfill=1`
read-time pass was removed entirely — the ledger is write-through only, with the
admin-gated `POST /api/admin/backfill-ledger` as the sole manual sweep; see
AGENTS.md, "Financials Phase 0".)

---

# Showcase seed (`seed-showcase.mjs`)

The home page's sample story ("Seattle Homes", Avery Morgan, Jordan Rivera,
Pacific Plumbing) as real rows on the **dev/test** Supabase project, so a capture
script can sign in and screenshot every portal page with data on it. It mirrors
`src/components/marketing/site/product-mock/{world,fixtures}.ts`.

```bash
npm run seed:showcase           # = node --env-file=.env.local scripts/seed-showcase.mjs
```

| Login | Password | Portal |
|---|---|---|
| `showcase.manager@test.proplane.local` | `ShowcaseManager123!` | manager (Business plan, workspace "Seattle Homes") |
| `showcase.resident@test.proplane.local` | `ShowcaseResident123!` | resident (Jordan Rivera, Willow Court Room 3, lease signed) |
| `showcase.vendor@test.proplane.local` | `ShowcaseVendor123!` | vendor (Pacific Plumbing, Marcus Lee) |

**Safety.** It calls `assertTestProjectUrl` and refuses unless the Supabase URL
is the dev/test project (`emstjswhotsnyksqhqyf`); it never reads
`.env.production*`. It only touches auth users it created (`user_metadata.showcase`)
and aborts rather than reset an existing account it did not create, so the
canonical `manager@` / `manager2@` / `resident@` / `vendor@test.proplane.local`
accounts and the locked live listings are never written. Every row it writes is
scoped to the showcase manager (or vendor) and is deleted and recreated each
run, so re-running never duplicates.

**What it fills.** 4 properties without photos (Willow Court, Alder House, Maple
Duplex, Fremont Studio), 17 applications (pending, incomplete, approved,
rejected), 11 leases across Draft / Manager review / Resident signature /
Manager signature / Signed, charges (paid / pending / overdue) with rent
profiles, 15 services (Open / Assigned / Scheduled / Completed) plus 3 add-on
requests, 4 vendors with quotes, invoices, payouts and 6 reviews, tours
(pending / upcoming / past), tasks, bookings, calendar, Communication threads
for all three portals, move-in forms, ledger + expenses, documents and
Promotion assets (built by the app's own default-asset builder).

**Caveats.**
- `npm run test:seed` prunes every non-canonical auth account on the test
  project, which deletes these three logins. Re-run `npm run seed:showcase`
  after a full reseed.
- Only Jordan has a login. The other residents are rows keyed by the
  fixtures' `@example.com` emails (some belong to other seeds' accounts, so no
  auth user is created or touched for them).
- The dev DB can lag the repo's migrations. The script skips what the dev schema
  cannot hold and says so (for example the `vendor-documents` storage bucket
  and the vendor calendar `event` rule kind).
