-- Platform hold when a manager or vendor has no Connect + bank yet.
-- Destination charges skip this table. Leftover holds transfer at connect,
-- never on Withdraw.
create table if not exists public.platform_payment_holds (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  owner_role text not null check (owner_role in ('manager', 'vendor')),
  source text not null check (source in ('household_charge', 'application_fee', 'vendor_invoice')),
  source_id text not null,
  amount_cents integer not null check (amount_cents > 0),
  status text not null check (status in ('held', 'transferred', 'refunded')),
  stripe_charge_id text,
  stripe_transfer_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source, source_id)
);

create index if not exists platform_payment_holds_owner_status_idx
  on public.platform_payment_holds (owner_user_id, status);

alter table public.platform_payment_holds enable row level security;

-- Writes are service-role only. Owner may read their own rows.
drop policy if exists platform_payment_holds_owner_read on public.platform_payment_holds;
create policy platform_payment_holds_owner_read on public.platform_payment_holds
  for select using (owner_user_id = auth.uid());
