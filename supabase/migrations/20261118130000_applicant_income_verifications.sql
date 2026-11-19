-- Plaid-verified applicant income. One row per (applicant, listing): the figure is computed on the server from the
-- applicant's own linked bank and stamped onto the application by the signed-in write. Service role only (no client
-- grants); no Plaid access token is stored (the item is removed right after the figure is computed).
create table if not exists public.applicant_income_verifications (
  user_id uuid not null references auth.users (id) on delete cascade,
  property_id text not null,
  monthly_income_cents integer not null check (monthly_income_cents > 0),
  months smallint not null check (months > 0),
  deposit_count integer not null default 0,
  institution_name text,
  verified_at timestamptz not null default now(),
  primary key (user_id, property_id)
);

alter table public.applicant_income_verifications enable row level security;
revoke all on public.applicant_income_verifications from public, anon, authenticated;
grant all on public.applicant_income_verifications to service_role;
