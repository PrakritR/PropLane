-- PropLane's own revenue from the vendor service fee (VENDOR_PAY_FEE_BPS, 3%).
--
-- Additive, idempotent. Write-through: a row is appended next to the DB write
-- that settles a Stripe-rail vendor payment (kind 'vendor_service_fee') and,
-- negated, next to the vendor statement fee reversal on a refund or an expired
-- hold ('vendor_service_fee_reversal'). The vendor-facing statement debit in
-- vendor_banking_ledger_entries is the vendor's view of the same fee; this
-- table is PropLane's. Nothing reads it to move money.
--
-- vendor_user_id / manager_user_id deliberately carry NO foreign key: revenue
-- history must outlive the accounts that produced it.
create table if not exists public.platform_revenue_entries (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('vendor_service_fee', 'vendor_service_fee_reversal')),
  amount_cents integer not null,
  vendor_user_id uuid null,
  manager_user_id uuid null,
  source text not null check (source in ('work_order', 'invoice', 'refund', 'hold_expiry')),
  source_id text not null,
  idempotency_key text not null unique,
  description text not null,
  created_at timestamptz not null default now()
);

create index if not exists platform_revenue_entries_created_idx
  on public.platform_revenue_entries (created_at);
create index if not exists platform_revenue_entries_source_idx
  on public.platform_revenue_entries (source, source_id);
create index if not exists platform_revenue_entries_vendor_idx
  on public.platform_revenue_entries (vendor_user_id, created_at);

alter table public.platform_revenue_entries enable row level security;

-- No anon/authenticated policy at all: service role only.
revoke all on table public.platform_revenue_entries from anon, authenticated;
grant all on table public.platform_revenue_entries to service_role;
