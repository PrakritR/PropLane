-- Vendor banking (VENDOR_BANKING_ENABLED, default off; night/vendor-banking).
--
-- Additive, idempotent. With the flag off, no code path writes to any table
-- here — see src/lib/vendor-banking/flag.ts and the call sites that gate on
-- it before ever inserting a row.
--
-- 1) vendor_payouts grows optional invoice-sourced rows + refund/fee tracking
--    so a single table anchors "a vendor payment", whether it came from a
--    work order (existing) or a directly-requested invoice (new, "Request
--    payment"). work_order_id becomes nullable; exactly one of
--    work_order_id/invoice_id must be set.
alter table public.vendor_payouts alter column work_order_id drop not null;
alter table public.vendor_payouts add column if not exists invoice_id uuid references public.vendor_invoices (id);
alter table public.vendor_payouts add column if not exists platform_fee_cents integer not null default 0;
alter table public.vendor_payouts add column if not exists refunded_gross_cents integer not null default 0;
alter table public.vendor_payouts add column if not exists refunded_fee_cents integer not null default 0;
alter table public.vendor_payouts add column if not exists stripe_charge_id text;
alter table public.vendor_payouts add column if not exists destination text
  check (destination in ('destination_charge', 'hold'));

alter table public.vendor_payouts drop constraint if exists vendor_payouts_status_check;
alter table public.vendor_payouts add constraint vendor_payouts_status_check
  check (status in ('pending', 'paid', 'failed', 'skipped', 'refunded', 'partially_refunded'));

alter table public.vendor_payouts drop constraint if exists vendor_payouts_source_check;
alter table public.vendor_payouts add constraint vendor_payouts_source_check
  check (work_order_id is not null or invoice_id is not null);

drop index if exists public.vendor_payouts_work_order_unique;
create unique index if not exists vendor_payouts_work_order_unique
  on public.vendor_payouts (work_order_id) where work_order_id is not null;
create unique index if not exists vendor_payouts_invoice_unique
  on public.vendor_payouts (invoice_id) where invoice_id is not null;

-- 2) The vendor statement: every money-moving line item vendor banking ever
-- writes, signed cents (credit positive / debit negative), append-only. The
-- running balance a Statement shows is the cumulative sum of these rows in
-- order — never hand-computed elsewhere. RLS is service-role only, same
-- posture as proplane_balance_entries: every read goes through
-- src/lib/vendor-banking/ledger.server.ts.
create table if not exists public.vendor_banking_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  vendor_user_id uuid not null references auth.users (id) on delete cascade,
  manager_user_id uuid references auth.users (id) on delete set null,
  kind text not null check (kind in ('charge', 'platform_fee', 'hold', 'transfer', 'withdrawal', 'refund', 'adjustment')),
  amount_cents integer not null,
  source text not null check (source in ('work_order', 'invoice', 'withdrawal', 'refund', 'hold_expiry', 'adjustment')),
  source_id text,
  description text not null,
  stripe_object_id text,
  idempotency_key text unique,
  created_at timestamptz not null default now()
);

create index if not exists vendor_banking_ledger_entries_vendor_idx
  on public.vendor_banking_ledger_entries (vendor_user_id, created_at);

alter table public.vendor_banking_ledger_entries enable row level security;
-- No anon/authenticated policy at all — every read goes through the
-- service-role statement API, mirroring proplane_balance_entries.

-- 3) Reconciliation stamp: one row per vendor, upserted by the nightly job
-- comparing this ledger's running total against the vendor's own connected
-- account's Stripe balance transactions ("Matches Stripe · last checked …").
create table if not exists public.vendor_banking_reconciliation (
  vendor_user_id uuid primary key references auth.users (id) on delete cascade,
  reconciled_at timestamptz not null default now(),
  matches boolean not null,
  ledger_total_cents integer not null,
  stripe_total_cents integer not null,
  note text,
  updated_at timestamptz not null default now()
);

alter table public.vendor_banking_reconciliation enable row level security;
drop policy if exists vendor_banking_reconciliation_owner_read on public.vendor_banking_reconciliation;
create policy vendor_banking_reconciliation_owner_read on public.vendor_banking_reconciliation
  for select using (vendor_user_id = auth.uid());

-- 4) Refund shortfall: when a refund's vendor-side debit exceeds what can be
-- clawed back right now (the hold/transfer/balance actually available), the
-- uncoverable remainder is recorded here and drawn down from the vendor's
-- NEXT settled payment (see applyOutstandingShortfall in
-- src/lib/vendor-banking/shortfall.server.ts) rather than silently failing
-- or letting a refund go unrecorded.
create table if not exists public.vendor_banking_shortfalls (
  vendor_user_id uuid primary key references auth.users (id) on delete cascade,
  outstanding_cents integer not null default 0 check (outstanding_cents >= 0),
  updated_at timestamptz not null default now()
);

alter table public.vendor_banking_shortfalls enable row level security;
-- Service-role only — no owner policy. The vendor sees the shortfall via the
-- refund modal's own response and the statement line it produces, never a
-- direct table read.

create or replace function public.vendor_banking_add_shortfall(p_vendor_user_id uuid, p_cents integer)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_outstanding integer;
begin
  if p_cents is null or p_cents <= 0 then
    raise exception 'p_cents must be positive';
  end if;
  insert into public.vendor_banking_shortfalls (vendor_user_id, outstanding_cents)
  values (p_vendor_user_id, p_cents)
  on conflict (vendor_user_id) do update
    set outstanding_cents = public.vendor_banking_shortfalls.outstanding_cents + excluded.outstanding_cents,
        updated_at = now()
  returning outstanding_cents into v_outstanding;
  return v_outstanding;
end $$;

revoke all on function public.vendor_banking_add_shortfall(uuid, integer) from public, anon, authenticated;
grant execute on function public.vendor_banking_add_shortfall(uuid, integer) to service_role;

-- Atomically draws down up to p_available_cents from the vendor's outstanding
-- shortfall, returning the amount actually applied. Used at the next payment
-- settle to reduce what the vendor is credited until the shortfall clears.
create or replace function public.vendor_banking_drawdown_shortfall(p_vendor_user_id uuid, p_available_cents integer)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_outstanding integer;
  v_applied integer;
begin
  if p_available_cents is null or p_available_cents <= 0 then
    return 0;
  end if;
  select outstanding_cents into v_outstanding
  from public.vendor_banking_shortfalls
  where vendor_user_id = p_vendor_user_id
  for update;
  if v_outstanding is null or v_outstanding <= 0 then
    return 0;
  end if;
  v_applied := least(v_outstanding, p_available_cents);
  update public.vendor_banking_shortfalls
  set outstanding_cents = outstanding_cents - v_applied, updated_at = now()
  where vendor_user_id = p_vendor_user_id;
  return v_applied;
end $$;

revoke all on function public.vendor_banking_drawdown_shortfall(uuid, integer) from public, anon, authenticated;
grant execute on function public.vendor_banking_drawdown_shortfall(uuid, integer) to service_role;
