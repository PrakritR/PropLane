-- Rent reporting to credit bureaus (Wave 2, PLAN-0920-1051).
--
-- One resident/lease pair enrolls in reporting through `resident_rent_reporting`;
-- each monthly submission that gets (or would get, for the stub partner) sent to the
-- reseller furnisher partner is a row in `rent_reporting_submissions`. Consent gates
-- every export (`src/lib/rent-reporting/consent.server.ts`); status is derived from
-- the payments ledger, never model arithmetic (`src/lib/rent-reporting/export.server.ts`).
--
-- No client writes: RLS grants the resident SELECT on their own rows only. Every write
-- (start, stop, submission insert) goes through a route or the cron job on the
-- service-role client. Idempotent: `create table if not exists`, `drop policy if
-- exists` before `create policy`.

create table if not exists public.resident_rent_reporting (
  id uuid primary key default gen_random_uuid(),
  resident_user_id uuid not null references auth.users (id) on delete cascade,
  manager_user_id uuid not null references auth.users (id) on delete cascade,
  property_id text,
  lease_id text,
  status text not null default 'active' check (status in ('active', 'paused', 'stopped')),
  consented_at timestamptz,
  stopped_at timestamptz,
  legal_name_encrypted text,
  dob_encrypted text,
  partner_subject_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (resident_user_id, property_id)
);

create index if not exists resident_rent_reporting_manager_idx
  on public.resident_rent_reporting (manager_user_id, status);

create index if not exists resident_rent_reporting_resident_idx
  on public.resident_rent_reporting (resident_user_id);

create table if not exists public.rent_reporting_submissions (
  id uuid primary key default gen_random_uuid(),
  reporting_id uuid not null references public.resident_rent_reporting (id) on delete cascade,
  resident_user_id uuid not null references auth.users (id) on delete cascade,
  period text not null,
  amount_cents bigint not null check (amount_cents >= 0),
  due_date date not null,
  paid_date date,
  status text not null check (status in ('on_time', 'late_30', 'late_60', 'late_90', 'unpaid')),
  sent_at timestamptz,
  partner_receipt jsonb,
  created_at timestamptz not null default now(),
  unique (reporting_id, period)
);

create index if not exists rent_reporting_submissions_reporting_idx
  on public.rent_reporting_submissions (reporting_id, period);

create index if not exists rent_reporting_submissions_resident_idx
  on public.rent_reporting_submissions (resident_user_id);

alter table public.resident_rent_reporting enable row level security;
alter table public.rent_reporting_submissions enable row level security;

drop policy if exists resident_rent_reporting_resident_read on public.resident_rent_reporting;
create policy resident_rent_reporting_resident_read on public.resident_rent_reporting
  for select using (resident_user_id = auth.uid());

drop policy if exists rent_reporting_submissions_resident_read on public.rent_reporting_submissions;
create policy rent_reporting_submissions_resident_read on public.rent_reporting_submissions
  for select using (resident_user_id = auth.uid());

comment on table public.resident_rent_reporting is
  'Consent + enrollment for reporting one resident''s rent history to credit bureaus through the reseller furnisher partner (src/lib/rent-reporting/partner.ts). No client writes; resident reads their own row only.';
comment on table public.rent_reporting_submissions is
  'One row per (reporting_id, period) monthly submission, status derived from the payments ledger at export time. No client writes; resident reads their own rows only.';
