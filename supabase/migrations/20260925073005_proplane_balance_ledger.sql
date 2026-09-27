-- PropLane balance ledger (night/vendor-pay, captain's ask 2026-09-25).
--
-- One PropLane-controlled Stripe platform account + a per-manager ("workspace")
-- and per-vendor internal ledger balance, mirroring `research.md`'s "Recommended
-- money architecture" (separate charges and transfers). This migration is
-- INERT until `PROPLANE_BALANCE_ENABLED=1` — nothing in the application writes
-- to these tables unless the flag is on (see `src/lib/proplane-balance/flag.ts`).
--
-- `owner_kind = 'workspace'` uses the MANAGER's `profiles.id` as `owner_key` —
-- not `portal_workspaces.id`. Stripe Connect account ids, and every existing
-- money path in this codebase, are keyed on the manager user, not the
-- workspace row (`profiles.stripe_connect_account_id`); a workspace has no
-- Connect account of its own. "workspace" here names the payable ENTITY the
-- captain's ask described, resolved onto the identity the rest of Financials
-- already uses. See docs/agents/financials.md and .lavish/night/build-vendor-pay.md.
--
-- The ledger is a STRICT MIRROR of real Stripe objects — every entry that
-- represents money actually moving carries the real Stripe id in
-- `stripe_object_id` (a charge id for a resident-payment credit, a transfer id
-- for a withdrawal). A `vendor_payment_out` / `vendor_payment_in` pair moves no
-- real money (both sides already sit in PropLane's one platform balance), so it
-- carries no Stripe object id by design.

create table if not exists public.proplane_balance_accounts (
  id uuid primary key default gen_random_uuid(),
  owner_kind text not null check (owner_kind in ('workspace', 'vendor')),
  owner_key text not null check (char_length(trim(owner_key)) > 0),
  currency text not null default 'usd' check (char_length(currency) = 3),
  created_at timestamptz not null default now(),
  unique (owner_kind, owner_key, currency)
);

create table if not exists public.proplane_balance_entries (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.proplane_balance_accounts(id) on delete cascade,
  amount_cents bigint not null check (amount_cents <> 0),
  kind text not null check (
    kind in (
      'resident_payment',
      'vendor_payment_out',
      'vendor_payment_in',
      'withdrawal',
      'withdrawal_reversal',
      'fee',
      'adjustment'
    )
  ),
  status text not null default 'available' check (status in ('pending', 'available')),
  available_on timestamptz,
  -- Real Stripe object this entry mirrors (charge id, transfer id, …). Null for
  -- an internal-only double-entry leg (vendor_payment_out/in) that moves no
  -- real money, and briefly null for a just-claimed withdrawal (see the
  -- partial unique index below).
  stripe_object_id text,
  idempotency_key text unique,
  related_entry_id uuid references public.proplane_balance_entries(id),
  created_at timestamptz not null default now()
);

create index if not exists proplane_balance_entries_account_status_idx
  on public.proplane_balance_entries (account_id, status);

create index if not exists proplane_balance_entries_pending_available_on_idx
  on public.proplane_balance_entries (account_id, available_on)
  where status = 'pending';

-- Claim-before-call, same pattern as `stripe_payouts_pending_claim_unique`
-- (20260920200000_in_app_payouts.sql): at most one in-flight withdrawal claim
-- per account. The claim entry is inserted with `stripe_object_id = null`;
-- stamping it with the real transfer id (success) OR a `reversed:<ts>` sentinel
-- (the transfer call itself failed — no real money moved) frees the slot for
-- the next withdrawal.
create unique index if not exists proplane_balance_withdrawal_claim_unique
  on public.proplane_balance_entries (account_id)
  where kind = 'withdrawal' and stripe_object_id is null;

-- No client writes, no client reads: every access to this ledger goes through
-- a service-role API route (see .lavish/night/BUILD-RULES.md). RLS is enabled
-- as defense in depth; no policy is granted to anon/authenticated, so
-- PostgREST denies both tables outright for those roles. service_role bypasses
-- RLS (Supabase default) and keeps its full grants.
alter table public.proplane_balance_accounts enable row level security;
alter table public.proplane_balance_entries enable row level security;
revoke all on public.proplane_balance_accounts from anon, authenticated;
revoke all on public.proplane_balance_entries from anon, authenticated;

-- --------------------------------------------------------------------------
-- Functions. All security definer, all locked to service_role — never called
-- by an anon/authenticated PostgREST session, only by our own server routes
-- through the service-role client (`db.rpc(...)`).
-- --------------------------------------------------------------------------

create or replace function public.proplane_balance_ensure_account(
  p_owner_kind text,
  p_owner_key text,
  p_currency text default 'usd'
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_currency text := coalesce(nullif(trim(p_currency), ''), 'usd');
  v_id uuid;
begin
  if p_owner_kind not in ('workspace', 'vendor') then
    raise exception 'invalid owner_kind: %', p_owner_kind;
  end if;
  if coalesce(trim(p_owner_key), '') = '' then
    raise exception 'owner_key required';
  end if;

  insert into public.proplane_balance_accounts (owner_kind, owner_key, currency)
  values (p_owner_kind, trim(p_owner_key), v_currency)
  on conflict (owner_kind, owner_key, currency) do nothing;

  select id into v_id
  from public.proplane_balance_accounts
  where owner_kind = p_owner_kind and owner_key = trim(p_owner_key) and currency = v_currency;

  return v_id;
end $$;

revoke all on function public.proplane_balance_ensure_account(text, text, text) from public, anon, authenticated;
grant execute on function public.proplane_balance_ensure_account(text, text, text) to service_role;

-- Flips due pending entries (a settled resident-payment credit whose
-- `available_on` has passed) to available. Idempotent; call before any balance
-- read, payment, or withdrawal for the account.
create or replace function public.proplane_balance_settle_due(p_account_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.proplane_balance_entries
  set status = 'available'
  where account_id = p_account_id
    and status = 'pending'
    and available_on is not null
    and available_on <= now();
end $$;

revoke all on function public.proplane_balance_settle_due(uuid) from public, anon, authenticated;
grant execute on function public.proplane_balance_settle_due(uuid) to service_role;

create or replace function public.proplane_balance_available_cents(p_account_id uuid)
returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(amount_cents), 0)::bigint
  from public.proplane_balance_entries
  where account_id = p_account_id and status = 'available';
$$;

revoke all on function public.proplane_balance_available_cents(uuid) from public, anon, authenticated;
grant execute on function public.proplane_balance_available_cents(uuid) to service_role;

create or replace function public.proplane_balance_pending_cents(p_account_id uuid)
returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(amount_cents), 0)::bigint
  from public.proplane_balance_entries
  where account_id = p_account_id and status = 'pending';
$$;

revoke all on function public.proplane_balance_pending_cents(uuid) from public, anon, authenticated;
grant execute on function public.proplane_balance_pending_cents(uuid) to service_role;

-- Double-entry internal move (e.g. "Pay vendor from PropLane balance"): debits
-- `p_payer_account_id`, credits `p_payee_account_id`, atomically, inside ONE
-- transaction with both account rows locked (in a fixed id order, to avoid a
-- lock-order deadlock against a concurrent reverse-direction move) so a
-- concurrent call never double-spends the same available balance. Raises
-- `INSUFFICIENT_BALANCE: available=<n> requested=<n>` rather than moving
-- anything short. `p_idempotency_root` makes the whole move idempotent: a
-- replay with the same root returns the SAME two entry ids instead of moving
-- money twice.
create or replace function public.proplane_balance_move(
  p_payer_account_id uuid,
  p_payee_account_id uuid,
  p_amount_cents bigint,
  p_payer_kind text,
  p_payee_kind text,
  p_idempotency_root text
) returns table(payer_entry_id uuid, payee_entry_id uuid)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_key_out text := p_idempotency_root || ':out';
  v_key_in text := p_idempotency_root || ':in';
  v_payer_out uuid;
  v_payee_in uuid;
  v_available bigint;
  v_first uuid;
  v_second uuid;
begin
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'amount_cents must be positive';
  end if;
  if p_payer_account_id = p_payee_account_id then
    raise exception 'payer and payee accounts must differ';
  end if;

  -- Idempotent replay: both legs already exist under this root.
  select id into v_payer_out from public.proplane_balance_entries where idempotency_key = v_key_out;
  if v_payer_out is not null then
    select id into v_payee_in from public.proplane_balance_entries where idempotency_key = v_key_in;
    return query select v_payer_out, v_payee_in;
    return;
  end if;

  if p_payer_account_id < p_payee_account_id then
    v_first := p_payer_account_id; v_second := p_payee_account_id;
  else
    v_first := p_payee_account_id; v_second := p_payer_account_id;
  end if;
  perform 1 from public.proplane_balance_accounts where id = v_first for update;
  perform 1 from public.proplane_balance_accounts where id = v_second for update;

  select coalesce(sum(amount_cents), 0) into v_available
  from public.proplane_balance_entries
  where account_id = p_payer_account_id and status = 'available';

  if v_available < p_amount_cents then
    raise exception 'INSUFFICIENT_BALANCE: available=% requested=%', v_available, p_amount_cents;
  end if;

  insert into public.proplane_balance_entries (account_id, amount_cents, kind, status, available_on, idempotency_key)
  values (p_payer_account_id, -p_amount_cents, p_payer_kind, 'available', now(), v_key_out)
  returning id into v_payer_out;

  insert into public.proplane_balance_entries
    (account_id, amount_cents, kind, status, available_on, idempotency_key, related_entry_id)
  values (p_payee_account_id, p_amount_cents, p_payee_kind, 'available', now(), v_key_in, v_payer_out)
  returning id into v_payee_in;

  update public.proplane_balance_entries set related_entry_id = v_payee_in where id = v_payer_out;

  return query select v_payer_out, v_payee_in;
end $$;

revoke all on function public.proplane_balance_move(uuid, uuid, bigint, text, text, text) from public, anon, authenticated;
grant execute on function public.proplane_balance_move(uuid, uuid, bigint, text, text, text) to service_role;

-- "Pay from PropLane balance" needs to record which rail actually settled the
-- invoice. Additive, existing rows default to null (read as "stripe" by the
-- app — see `mapVendorInvoiceRow`).
alter table public.vendor_invoices
  add column if not exists paid_from text check (paid_from in ('stripe', 'balance'));
