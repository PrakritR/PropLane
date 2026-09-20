-- Resident autopay (Wave 1).
--
-- `resident_autopay_settings` is the resident's enrollment: whether autopay is
-- on, which saved Stripe payment method it charges, and how many days before
-- the due date it runs (0-5, captain decision — autopay runs ON the due date
-- by default and the resident may move it up to 5 days earlier). Scoped per
-- resident PER HOUSEHOLD, using the same `residentEmail|propertyId` key
-- `recurringRentProfileKey` already groups a resident's recurring charges by
-- (src/lib/household-charges.ts), so a resident with more than one tenancy can
-- enroll each independently.
--
-- `resident_autopay_runs` is the idempotency + audit ledger: ONE row per
-- charge, ever. The unique constraint on `charge_id` is the double-charge
-- guard — claiming a run is an insert, and a unique-violation on that insert
-- means another pass (or a retry) already claimed this charge, so the caller
-- skips rather than charging twice.
--
-- Client roles get SELECT only, as with every other trust-signal table in this
-- app: all writes go through the service-role settings route / cron, which
-- re-derives ownership and never trusts an id from the request body.

create table if not exists public.resident_autopay_settings (
  id uuid primary key default gen_random_uuid(),
  resident_user_id uuid not null references auth.users(id) on delete cascade,
  manager_id uuid not null references auth.users(id) on delete cascade,
  -- `lower(residentEmail)|propertyId`, the same key recurring rent profiles
  -- group by. Lets one resident enroll more than one tenancy independently.
  household_key text not null,
  enabled boolean not null default false,
  payment_method_id text,
  run_days_before_due int not null default 0 check (run_days_before_due between 0 and 5),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (resident_user_id, household_key)
);

create table if not exists public.resident_autopay_runs (
  id uuid primary key default gen_random_uuid(),
  charge_id text not null unique,
  resident_user_id uuid not null references auth.users(id) on delete cascade,
  manager_id uuid not null references auth.users(id) on delete cascade,
  status text not null check (status in ('claimed', 'succeeded', 'failed')),
  stripe_payment_intent_id text,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists resident_autopay_settings_manager_idx
  on public.resident_autopay_settings (manager_id);
create index if not exists resident_autopay_runs_resident_idx
  on public.resident_autopay_runs (resident_user_id);
create index if not exists resident_autopay_runs_manager_idx
  on public.resident_autopay_runs (manager_id);

alter table public.resident_autopay_settings enable row level security;
alter table public.resident_autopay_runs enable row level security;

drop policy if exists resident_autopay_settings_select_own on public.resident_autopay_settings;
create policy resident_autopay_settings_select_own
  on public.resident_autopay_settings
  for select
  using (resident_user_id = auth.uid());

drop policy if exists resident_autopay_runs_select_own on public.resident_autopay_runs;
create policy resident_autopay_runs_select_own
  on public.resident_autopay_runs
  for select
  using (resident_user_id = auth.uid());

comment on table public.resident_autopay_settings is
  'Resident autopay enrollment, per resident per household. Writes go through the service-role /api/resident/autopay route only.';
comment on table public.resident_autopay_runs is
  'One row per charge, ever — the unique charge_id is the double-charge guard for the autopay cron. Writes go through the service-role cron / webhook only.';
