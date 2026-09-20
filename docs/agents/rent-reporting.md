# Rent reporting to credit bureaus

Moved out of the root `AGENTS.md` to keep it loadable; this is the authoritative copy.
Read it before changing code in this area.

## The shape: PropLane is a reseller behind one partner interface

PropLane never reports to Experian/TransUnion/Equifax itself — it resells a furnisher
partner (Esusu / Boom style). Every caller goes through the one
`RentReportingPartner` interface (`src/lib/rent-reporting/partner.ts`):
`enroll(subject)`, `submit(rows)`, `stop(partnerSubjectId)`. No partner is signed yet,
so `getRentReportingPartner()` currently resolves to `StubRentReportingPartner`, which
records what would be sent (no network call, no live bureau submission). Swapping in
the signed partner's real client is a one-file change at that one call site; nothing
else in the app should import a partner SDK directly.

## Consent gates every export

A resident enrolls per (resident, property) in `resident_rent_reporting` — `status`
is `active` / `paused` / `stopped`, `legal_name_encrypted` / `dob_encrypted` hold the
identity typed into the consent sheet, encrypted at rest with
`src/lib/security/data-encryption.ts` (`encryptSensitiveValue` /
`decryptSensitiveValue`, context `purpose: "rent-reporting-consent"`, bound to the
row id and the manager id so one row's ciphertext can never open another's).
`src/lib/rent-reporting/consent.server.ts` owns start/stop; RLS grants the resident
`SELECT` on their own row only (`supabase/migrations/20260920220000_rent_reporting.sql`)
— every write goes through the resident route
(`src/app/api/resident/rent-reporting/route.ts`) or the monthly cron, both on the
service-role client.

The monthly export (`buildRentReportingRowsForPeriod`,
`src/lib/rent-reporting/export.server.ts`) only ever considers rows with
`status = 'active'`. A `stopped` row drops out of the very next cycle — reporting
never runs retroactively and never deletes a submission already sent.

## Late derives from the ledger, never model arithmetic

`deriveRentReportingSubmissionStatus` buckets a period's rent charge straight off its
own due date, paid date, and the manager's configured late-fee grace period
(`lateFeePolicyFromSubmission`, `src/lib/payment-policy.ts`):

- No paid date yet → `unpaid`.
- Paid within the grace period → `on_time`.
- Past grace: 1–30 days late → `late_30`, 31–60 → `late_60`, 61+ → `late_90` (the
  same three-tier severity Metro 2 furnishers use; there is no fourth bucket).
- **A waived late fee counts as `on_time`** regardless of how many days late the
  payment actually landed — a waived late fee (a `late_fee`-kind charge with
  `sourceChargeId` pointing at the rent charge, `status: "cancelled"`) means the
  manager formally excused the lateness, and the report should say so.

Only rent-kind charges are ever reported (`rent`, `first_month_rent`,
`prorated_rent`, `prorated_last_month_rent`) — utilities, fees, and deposits never
are. A resident with no rent charge yet for a period is skipped entirely for that
period, never synthesized as `unpaid`.

## The monthly cycle

`src/app/api/cron/report-rent-monthly/route.ts` runs on the 5th of each month
(`vercel.json`), reports the calendar month that just closed, and is idempotent by
`(reporting_id, period)` (`rent_reporting_submissions`'s own unique constraint) — a
redelivered run only ever submits rows that period has not already recorded. It also
re-checks the manager's add-on flag every cycle: a manager who turns the add-on off
after a resident already consented stops that resident's reporting the next month
too, not just new consents.

## The manager add-on

Settings → Billing & plan → Add-ons → "Rent reporting", gated on
`resolveEffectiveManagerSkuTier` / `planTierCanHoldAddons` (Pro and Business only,
same as every other add-on) — `src/app/api/manager/rent-reporting-addon/route.ts`.

This is deliberately **not** one of `PLAN_ADDONS` (`src/lib/plan-addons.ts`): that
catalogue is a manager-CHOSEN quantity wired one-to-one to a Stripe subscription item
(extra listings, seats, work numbers…). Rent reporting's cost scales with however
many residents opt in this month — a number the manager does not choose — so it is a
simple On/Off switch, stored at
`manager_automation_settings.row_data.rentReportingAddon`
(`src/lib/rent-reporting/manager-settings.server.ts`, the same no-migration-needed
`row_data` pattern `manager-tour-settings.ts` and friends use). The read-only
"Residents reporting · N of M" row counts active `resident_rent_reporting` rows over
current rent-paying households (an active `portal_recurring_rent_profile_records`
row — the same "is this a current resident" definition the payment-reminders cron
already uses).

### Billing status (deliberately not built)

The spec is $2 per reporting resident per month. The existing reserve-then-charge
path (`docs/agents/comms-billing.md`) is metered per message/call/AI turn at send
time — it has no shape for "N active enrollments this month" the way a recurring
per-seat charge does, and bolting that on would be a second billing model growing
out of the first one's plumbing rather than a clean fit. **This wave does not wire
the $2/resident/month charge to anything** — turning the add-on on does not create a
Stripe subscription item, an invoice line, or a comms-wallet debit. The toggle and
the resident count are real and drive real reporting; the charge is a TODO for
whoever designs the actual billing mechanism (a `PLAN_ADDONS`-style Stripe metered
item is the most likely fit, but that is a real design decision, not a two-line
follow-up).

## Purge

Both tables are classified in `src/lib/auth/account-purge-manifest.ts`:
`resident_rent_reporting` deletes on either the resident's or the manager's account
purge; `rent_reporting_submissions` has no `manager_user_id` column of its own and
cascades from `resident_rent_reporting` on a manager purge, while its own
`resident_user_id` is classified directly for a resident purge. Coverage:
`tests/unit/account-purge-coverage.test.ts`.

## Agent tool

`rent_reporting_status` (resident registry only, `src/lib/tools/domains/resident/rent-reporting.ts`)
is read-only: enrollment status plus the most recent submission. There is no write
tool — turning reporting on requires typed consent (legal name + DOB), so that stays
a resident-portal-only action the assistant can never perform on the resident's
behalf.

## Coverage

`tests/unit/rent-reporting-export.test.ts` (status derivation buckets, waived late
fee, no-consent-no-rows), `tests/unit/rent-reporting-routes.test.ts` (add-on-off
refusal, start encrypts at rest, stop excludes the row from the next export),
`tests/unit/resident-rent-reporting-card.test.tsx` (off → consent sheet → on, and the
Free-plan Upgrade lock).
