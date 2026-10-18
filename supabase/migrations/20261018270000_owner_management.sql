-- Owner management (W17): management agreements, the per-payment rent split, repair approvals and
-- monthly owner statements. Additive and idempotent. Service role only (no anon/authenticated grants).
-- Design and invariants: docs/agents/owner-management.md.

-- ---------------------------------------------------------------------------------------------
-- Agreements: one per house per period. Terms are immutable once signed.
-- ---------------------------------------------------------------------------------------------
create table if not exists public.owner_management_agreements (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.portal_workspaces (id) on delete set null,
  manager_user_id uuid not null references auth.users (id) on delete cascade,
  property_id text not null,
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  status text not null default 'draft' check (status in ('draft', 'active', 'ended')),
  fee_model text not null check (fee_model in ('percent_of_collected', 'flat_monthly')),
  fee_bps integer not null default 0 check (fee_bps between 0 and 3000),
  fee_flat_cents integer not null default 0 check (fee_flat_cents between 0 and 500000),
  leasing_fee_bps integer not null default 0 check (leasing_fee_bps between 0 and 10000),
  min_fee_cents integer not null default 0 check (min_fee_cents between 0 and 500000),
  reserve_target_cents integer not null default 0 check (reserve_target_cents between 0 and 100000000),
  repair_approval_threshold_cents integer not null default 25000
    check (repair_approval_threshold_cents between 0 and 5000000),
  starts_on date not null,
  ends_on date,
  sent_at timestamptz,
  signed_at timestamptz,
  terms_sha256 text,
  terms_snapshot jsonb,
  ended_at timestamptz,
  ended_by_role text check (ended_by_role in ('manager', 'admin', 'owner', 'system')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint owner_agreements_dates check (ends_on is null or ends_on >= starts_on),
  constraint owner_agreements_fee_set check (
    (fee_model = 'percent_of_collected' and fee_bps > 0) or (fee_model = 'flat_monthly' and fee_flat_cents > 0)
  ),
  constraint owner_agreements_active_signed check (
    status <> 'active' or (signed_at is not null and terms_sha256 is not null)
  )
);
create unique index if not exists owner_agreements_one_active_per_property
  on public.owner_management_agreements (property_id) where status = 'active';
create index if not exists owner_agreements_manager_idx on public.owner_management_agreements (manager_user_id, property_id);
create index if not exists owner_agreements_owner_idx on public.owner_management_agreements (owner_user_id, status);

-- A signed agreement's terms never change (same discipline as a signed lease); only ending it, and the
-- owner's own repair threshold, may move.
create or replace function public.owner_agreement_terms_immutable()
returns trigger language plpgsql as $$
begin
  if old.signed_at is not null and (
    new.manager_user_id is distinct from old.manager_user_id or
    new.property_id is distinct from old.property_id or
    new.owner_user_id is distinct from old.owner_user_id or
    new.fee_model is distinct from old.fee_model or
    new.fee_bps is distinct from old.fee_bps or
    new.fee_flat_cents is distinct from old.fee_flat_cents or
    new.leasing_fee_bps is distinct from old.leasing_fee_bps or
    new.min_fee_cents is distinct from old.min_fee_cents or
    new.starts_on is distinct from old.starts_on or
    new.signed_at is distinct from old.signed_at or
    new.terms_sha256 is distinct from old.terms_sha256 or
    new.terms_snapshot is distinct from old.terms_snapshot
  ) then
    raise exception 'A signed management agreement cannot be edited. End it and draft a new one.';
  end if;
  if old.status = 'ended' and new.status <> 'ended' then
    raise exception 'An ended management agreement cannot be reopened.';
  end if;
  return new;
end;
$$;
drop trigger if exists owner_agreement_terms_immutable on public.owner_management_agreements;
create trigger owner_agreement_terms_immutable
  before update on public.owner_management_agreements
  for each row execute function public.owner_agreement_terms_immutable();

-- ---------------------------------------------------------------------------------------------
-- Fee reservations: one per checkout attempt, frozen before the provider call.
-- ---------------------------------------------------------------------------------------------
create table if not exists public.owner_fee_reservations (
  id uuid primary key default gen_random_uuid(),
  agreement_id uuid not null references public.owner_management_agreements (id) on delete cascade,
  manager_user_id uuid not null references auth.users (id) on delete cascade,
  property_id text not null,
  attempt_token uuid not null unique,
  month_key text not null check (month_key ~ '^\d{4}-\d{2}$'),
  principal_cents integer not null check (principal_cents > 0),
  monthly_fee_cents integer not null default 0 check (monthly_fee_cents >= 0),
  leasing_fee_cents integer not null default 0 check (leasing_fee_cents >= 0),
  expense_recoup_cents integer not null default 0 check (expense_recoup_cents >= 0),
  leasing_key text,
  charge_ids text[] not null default '{}',
  status text not null default 'reserved' check (status in ('reserved', 'settled', 'released')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint owner_fee_reservations_fee_bound check (monthly_fee_cents + leasing_fee_cents + expense_recoup_cents < principal_cents)
);
create unique index if not exists owner_fee_reservations_leasing_key
  on public.owner_fee_reservations (agreement_id, leasing_key)
  where leasing_key is not null and status in ('reserved', 'settled');
create index if not exists owner_fee_reservations_agreement_month_idx
  on public.owner_fee_reservations (agreement_id, month_key, status);

-- ---------------------------------------------------------------------------------------------
-- Allocations: one per paid rent component. `held` rows record what an unready owner is owed.
-- ---------------------------------------------------------------------------------------------
create table if not exists public.owner_rent_allocations (
  id uuid primary key default gen_random_uuid(),
  agreement_id uuid references public.owner_management_agreements (id) on delete set null,
  manager_user_id uuid not null references auth.users (id) on delete cascade,
  property_id text not null,
  owner_user_id uuid references auth.users (id) on delete set null,
  routing text not null check (routing in ('destination', 'held')),
  charge_id text not null,
  charge_kind text not null,
  stripe_payment_intent_id text not null,
  stripe_charge_id text,
  stripe_transfer_id text,
  stripe_application_fee_id text,
  destination_account_id text,
  month_key text not null check (month_key ~ '^\d{4}-\d{2}$'),
  paid_at timestamptz not null default now(),
  principal_cents integer not null check (principal_cents > 0),
  owner_processing_fee_cents integer not null default 0 check (owner_processing_fee_cents >= 0),
  monthly_fee_cents integer not null default 0 check (monthly_fee_cents >= 0),
  leasing_fee_cents integer not null default 0 check (leasing_fee_cents >= 0),
  expense_recoup_cents integer not null default 0 check (expense_recoup_cents >= 0),
  owner_net_cents integer not null check (owner_net_cents > 0),
  refunded_principal_cents integer not null default 0 check (refunded_principal_cents >= 0),
  refunded_fee_cents integer not null default 0 check (refunded_fee_cents >= 0),
  refunded_owner_cents integer not null default 0 check (refunded_owner_cents >= 0),
  disputed_cents integer not null default 0 check (disputed_cents >= 0),
  status text not null default 'settled'
    check (status in ('settled', 'partially_refunded', 'refunded', 'disputed', 'dispute_lost')),
  reservation_id uuid references public.owner_fee_reservations (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint owner_allocations_unique_source unique (stripe_payment_intent_id, charge_id),
  constraint owner_allocations_net check (
    owner_net_cents = principal_cents - owner_processing_fee_cents - monthly_fee_cents - leasing_fee_cents - expense_recoup_cents
  ),
  constraint owner_allocations_refund_bound check (refunded_principal_cents <= principal_cents)
);
create index if not exists owner_allocations_property_month_idx
  on public.owner_rent_allocations (property_id, month_key);
create index if not exists owner_allocations_agreement_month_idx
  on public.owner_rent_allocations (agreement_id, month_key);
create index if not exists owner_allocations_owner_idx on public.owner_rent_allocations (owner_user_id, month_key);
create index if not exists owner_allocations_charge_idx on public.owner_rent_allocations (stripe_charge_id);

-- ---------------------------------------------------------------------------------------------
-- Allocation events: every refund / dispute / reversal / payout applied once.
-- ---------------------------------------------------------------------------------------------
create table if not exists public.owner_allocation_events (
  id uuid primary key default gen_random_uuid(),
  allocation_id uuid not null references public.owner_rent_allocations (id) on delete cascade,
  kind text not null check (kind in (
    'refund', 'dispute_opened', 'dispute_lost', 'dispute_won', 'transfer_reversal', 'manual_payout', 'reconcile_flag'
  )),
  stripe_object_id text not null,
  amount_cents integer not null default 0 check (amount_cents >= 0),
  fee_cents integer not null default 0 check (fee_cents >= 0),
  owner_cents integer not null default 0 check (owner_cents >= 0),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint owner_allocation_events_once unique (allocation_id, kind, stripe_object_id)
);

-- ---------------------------------------------------------------------------------------------
-- Expenses and repair approvals.
-- ---------------------------------------------------------------------------------------------
create table if not exists public.owner_expenses (
  id uuid primary key default gen_random_uuid(),
  agreement_id uuid references public.owner_management_agreements (id) on delete set null,
  manager_user_id uuid not null references auth.users (id) on delete cascade,
  property_id text not null,
  owner_user_id uuid references auth.users (id) on delete set null,
  source_type text not null check (source_type in ('work_order', 'bill', 'manual')),
  source_id text not null,
  title text not null,
  vendor_label text,
  amount_cents integer not null check (amount_cents > 0),
  status text not null default 'pending_owner'
    check (status in ('pending_owner', 'auto_approved', 'approved', 'declined', 'collected', 'waived')),
  threshold_cents integer not null default 0,
  requested_at timestamptz not null default now(),
  approval_phone_key text,
  approval_sent_at timestamptz,
  decided_at timestamptz,
  decided_via text check (decided_via in ('sms', 'portal', 'auto', 'manager')),
  collected_cents integer not null default 0 check (collected_cents >= 0),
  collect_method text check (collect_method in ('rent_netting', 'outside_proplane')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint owner_expenses_source unique (source_type, source_id),
  constraint owner_expenses_collected check (collected_cents <= amount_cents)
);
create index if not exists owner_expenses_property_idx on public.owner_expenses (property_id, status);
create index if not exists owner_expenses_owner_pending_idx
  on public.owner_expenses (owner_user_id, status) where status = 'pending_owner';

-- ---------------------------------------------------------------------------------------------
-- Monthly statements: one per owner + house + Pacific month.
-- ---------------------------------------------------------------------------------------------
create table if not exists public.owner_statements (
  id uuid primary key default gen_random_uuid(),
  agreement_id uuid references public.owner_management_agreements (id) on delete set null,
  manager_user_id uuid not null references auth.users (id) on delete cascade,
  property_id text not null,
  owner_user_id uuid references auth.users (id) on delete set null,
  month_key text not null check (month_key ~ '^\d{4}-\d{2}$'),
  totals jsonb not null,
  emailed_at timestamptz,
  texted_at timestamptz,
  created_at timestamptz not null default now(),
  constraint owner_statements_once unique (property_id, month_key)
);
create index if not exists owner_statements_owner_idx on public.owner_statements (owner_user_id, month_key desc);

-- ---------------------------------------------------------------------------------------------
-- Access: service role only.
-- ---------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'owner_management_agreements', 'owner_fee_reservations', 'owner_rent_allocations',
    'owner_allocation_events', 'owner_expenses', 'owner_statements'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Month totals: what the fee math needs, read under the agreement lock by the reserve function.
-- Settled allocations (net of refunds) plus live reservations (a reserved row whose checkout attempt is
-- still pending / processing / settled, or younger than 10 minutes before an attempt row exists).
-- ---------------------------------------------------------------------------------------------
create or replace function public.owner_month_totals(p_agreement uuid, p_month text)
returns table (cum_principal bigint, monthly_fee bigint, leasing_fee bigint, recoup_outstanding bigint)
language sql stable security definer set search_path = public, pg_temp as $$
  with alloc as (
    select
      coalesce(sum(greatest(a.principal_cents - a.refunded_principal_cents, 0)), 0)::bigint as principal,
      coalesce(sum(greatest(a.monthly_fee_cents - least(a.refunded_fee_cents, a.monthly_fee_cents), 0)), 0)::bigint as monthly,
      coalesce(sum(greatest(a.leasing_fee_cents - greatest(a.refunded_fee_cents - a.monthly_fee_cents, 0), 0)), 0)::bigint as leasing
    from public.owner_rent_allocations a
    where a.agreement_id = p_agreement and a.month_key = p_month and a.routing = 'destination'
  ),
  live as (
    select
      coalesce(sum(r.principal_cents), 0)::bigint as principal,
      coalesce(sum(r.monthly_fee_cents), 0)::bigint as monthly,
      coalesce(sum(r.leasing_fee_cents), 0)::bigint as leasing
    from public.owner_fee_reservations r
    where r.agreement_id = p_agreement and r.month_key = p_month and r.status = 'reserved'
      and (
        exists (select 1 from public.resident_checkout_attempts t
                 where t.attempt_token = r.attempt_token and t.status in ('pending', 'processing', 'settled'))
        or (not exists (select 1 from public.resident_checkout_attempts t where t.attempt_token = r.attempt_token)
            and r.created_at > now() - interval '10 minutes')
      )
  ),
  expenses as (
    select coalesce(sum(e.amount_cents - e.collected_cents), 0)::bigint as outstanding
    from public.owner_expenses e
    where e.agreement_id = p_agreement and e.status in ('auto_approved', 'approved')
  ),
  live_recoup as (
    select coalesce(sum(r.expense_recoup_cents), 0)::bigint as reserved
    from public.owner_fee_reservations r
    where r.agreement_id = p_agreement and r.status = 'reserved'
      and (
        exists (select 1 from public.resident_checkout_attempts t
                 where t.attempt_token = r.attempt_token and t.status in ('pending', 'processing', 'settled'))
        or (not exists (select 1 from public.resident_checkout_attempts t where t.attempt_token = r.attempt_token)
            and r.created_at > now() - interval '10 minutes')
      )
  )
  select alloc.principal + live.principal,
         alloc.monthly + live.monthly,
         alloc.leasing + live.leasing,
         greatest(expenses.outstanding - live_recoup.reserved, 0)
  from alloc, live, expenses, live_recoup;
$$;

-- ---------------------------------------------------------------------------------------------
-- reserve_owner_fee: freeze one checkout's fee under the agreement lock. The caller computed the fee from
-- the totals it saw; the function answers `conflict` if they moved, and enforces the hard bounds either way.
-- ---------------------------------------------------------------------------------------------
create or replace function public.reserve_owner_fee(
  p_agreement uuid, p_attempt uuid, p_manager uuid, p_month text, p_principal integer,
  p_monthly_fee integer, p_leasing_fee integer, p_recoup integer, p_leasing_key text,
  p_charge_ids text[], p_expect_cum bigint, p_expect_monthly bigint
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ag public.owner_management_agreements%rowtype;
  v_existing public.owner_fee_reservations%rowtype;
  v_cum bigint; v_monthly bigint; v_leasing bigint; v_outstanding bigint;
  v_after bigint; v_base bigint; v_floor bigint; v_target bigint; v_new_id uuid;
begin
  select * into v_existing from public.owner_fee_reservations where attempt_token = p_attempt;
  if found then
    if v_existing.agreement_id is distinct from p_agreement or v_existing.principal_cents <> p_principal
       or v_existing.monthly_fee_cents <> p_monthly_fee or v_existing.leasing_fee_cents <> p_leasing_fee
       or v_existing.expense_recoup_cents <> p_recoup then
      return jsonb_build_object('status', 'refused', 'reason', 'attempt_differs');
    end if;
    return jsonb_build_object('status', 'reserved', 'reservation_id', v_existing.id);
  end if;

  select * into v_ag from public.owner_management_agreements where id = p_agreement for update;
  if not found or v_ag.status <> 'active' or v_ag.manager_user_id is distinct from p_manager then
    return jsonb_build_object('status', 'refused', 'reason', 'agreement_not_active');
  end if;
  if p_principal <= 0 or p_monthly_fee < 0 or p_leasing_fee < 0 or p_recoup < 0
     or p_monthly_fee + p_leasing_fee + p_recoup >= p_principal then
    return jsonb_build_object('status', 'refused', 'reason', 'bad_amounts');
  end if;

  select t.cum_principal, t.monthly_fee, t.leasing_fee, t.recoup_outstanding
    into v_cum, v_monthly, v_leasing, v_outstanding from public.owner_month_totals(p_agreement, p_month) t;
  if v_cum is distinct from p_expect_cum or v_monthly is distinct from p_expect_monthly then
    return jsonb_build_object('status', 'conflict', 'cum_principal', v_cum, 'monthly_fee', v_monthly);
  end if;

  -- Hard bounds, whatever the caller computed.
  v_after := v_cum + p_principal;
  if v_ag.fee_model = 'flat_monthly' then v_base := least(v_ag.fee_flat_cents, v_after);
  else v_base := (v_after * v_ag.fee_bps * 2 + 10000) / 20000;
  end if;
  v_floor := least(v_ag.min_fee_cents, v_after);
  v_target := least(greatest(v_base, v_floor), v_after);
  if v_monthly + p_monthly_fee > v_target then
    return jsonb_build_object('status', 'refused', 'reason', 'fee_over_agreement');
  end if;
  if p_leasing_fee > 0 and (v_ag.leasing_fee_bps <= 0 or p_leasing_key is null
     or p_leasing_fee > (p_principal::bigint * v_ag.leasing_fee_bps * 2 + 10000) / 20000) then
    return jsonb_build_object('status', 'refused', 'reason', 'leasing_over_agreement');
  end if;
  if p_recoup > v_outstanding or p_recoup > (p_principal / 2) then
    return jsonb_build_object('status', 'refused', 'reason', 'recoup_over_limit');
  end if;

  begin
    insert into public.owner_fee_reservations (
      agreement_id, manager_user_id, property_id, attempt_token, month_key, principal_cents,
      monthly_fee_cents, leasing_fee_cents, expense_recoup_cents, leasing_key, charge_ids
    ) values (
      p_agreement, p_manager, v_ag.property_id, p_attempt, p_month, p_principal,
      p_monthly_fee, p_leasing_fee, p_recoup, case when p_leasing_fee > 0 then p_leasing_key else null end,
      coalesce(p_charge_ids, '{}')
    ) returning id into v_new_id;
  exception when unique_violation then
    return jsonb_build_object('status', 'refused', 'reason', 'leasing_already_charged');
  end;
  return jsonb_build_object('status', 'reserved', 'reservation_id', v_new_id);
end;
$$;

create or replace function public.release_owner_fee_reservation(p_attempt uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.owner_fee_reservations set status = 'released', updated_at = now()
    where attempt_token = p_attempt and status = 'reserved';
  return found;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- credit_owner_rent_allocations: the one writer of allocation rows for a destination capture. Atomic and
-- idempotent: a replay inserts nothing and returns the existing rows. Applies the expense recoup, FIFO.
-- p_rows: [{charge_id, charge_kind, principal_cents, owner_processing_fee_cents, monthly_fee_cents,
--           leasing_fee_cents, expense_recoup_cents, owner_net_cents, paid_at}]
-- ---------------------------------------------------------------------------------------------
create or replace function public.credit_owner_rent_allocations(
  p_attempt uuid, p_agreement uuid, p_manager uuid, p_owner uuid, p_property text,
  p_payment_intent text, p_stripe_charge text, p_transfer text, p_fee_id text, p_destination text,
  p_month text, p_rows jsonb
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_res public.owner_fee_reservations%rowtype;
  v_ag public.owner_management_agreements%rowtype;
  v_row jsonb; v_inserted integer := 0; v_new uuid;
  v_sum_principal bigint := 0; v_sum_monthly bigint := 0; v_sum_leasing bigint := 0; v_sum_recoup bigint := 0;
  v_left bigint; v_exp record; v_take bigint;
begin
  select * into v_ag from public.owner_management_agreements where id = p_agreement for update;
  if not found or v_ag.manager_user_id is distinct from p_manager or v_ag.owner_user_id is distinct from p_owner
     or v_ag.property_id is distinct from p_property then
    raise exception 'Allocation does not match its agreement';
  end if;
  select * into v_res from public.owner_fee_reservations where attempt_token = p_attempt;
  if not found or v_res.agreement_id is distinct from p_agreement or v_res.status = 'released' then
    raise exception 'Allocation has no live fee reservation';
  end if;

  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_sum_principal := v_sum_principal + (v_row->>'principal_cents')::bigint;
    v_sum_monthly := v_sum_monthly + (v_row->>'monthly_fee_cents')::bigint;
    v_sum_leasing := v_sum_leasing + (v_row->>'leasing_fee_cents')::bigint;
    v_sum_recoup := v_sum_recoup + (v_row->>'expense_recoup_cents')::bigint;
  end loop;
  if v_sum_principal <> v_res.principal_cents or v_sum_monthly <> v_res.monthly_fee_cents
     or v_sum_leasing <> v_res.leasing_fee_cents or v_sum_recoup <> v_res.expense_recoup_cents then
    raise exception 'Allocation rows do not match the reserved fee';
  end if;

  for v_row in select * from jsonb_array_elements(p_rows) loop
    insert into public.owner_rent_allocations (
      agreement_id, manager_user_id, property_id, owner_user_id, routing, charge_id, charge_kind,
      stripe_payment_intent_id, stripe_charge_id, stripe_transfer_id, stripe_application_fee_id,
      destination_account_id, month_key, paid_at, principal_cents, owner_processing_fee_cents,
      monthly_fee_cents, leasing_fee_cents, expense_recoup_cents, owner_net_cents, reservation_id
    ) values (
      p_agreement, p_manager, p_property, p_owner, 'destination', v_row->>'charge_id', v_row->>'charge_kind',
      p_payment_intent, p_stripe_charge, p_transfer, p_fee_id, p_destination, p_month,
      coalesce((v_row->>'paid_at')::timestamptz, now()),
      (v_row->>'principal_cents')::integer, (v_row->>'owner_processing_fee_cents')::integer,
      (v_row->>'monthly_fee_cents')::integer, (v_row->>'leasing_fee_cents')::integer,
      (v_row->>'expense_recoup_cents')::integer, (v_row->>'owner_net_cents')::integer, v_res.id
    ) on conflict (stripe_payment_intent_id, charge_id) do nothing returning id into v_new;
    if v_new is not null then v_inserted := v_inserted + 1; end if;
    v_new := null;
  end loop;

  if v_res.status = 'reserved' then
    update public.owner_fee_reservations set status = 'settled', updated_at = now() where id = v_res.id;
    -- FIFO recoup against approved expenses, only on the first (inserting) pass.
    if v_inserted > 0 and v_sum_recoup > 0 then
      v_left := v_sum_recoup;
      for v_exp in
        select id, amount_cents, collected_cents from public.owner_expenses
          where agreement_id = p_agreement and status in ('auto_approved', 'approved') and collected_cents < amount_cents
          order by requested_at, id for update
      loop
        exit when v_left <= 0;
        v_take := least(v_left, v_exp.amount_cents - v_exp.collected_cents);
        update public.owner_expenses set collected_cents = collected_cents + v_take,
          collect_method = 'rent_netting',
          status = case when collected_cents + v_take >= amount_cents then 'collected' else status end,
          updated_at = now()
          where id = v_exp.id;
        v_left := v_left - v_take;
      end loop;
    end if;
  end if;
  return jsonb_build_object('inserted', v_inserted, 'reservation_id', v_res.id);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- apply_owner_allocation_event: a refund / dispute / reversal applied to one allocation exactly once.
-- ---------------------------------------------------------------------------------------------
create or replace function public.apply_owner_allocation_event(
  p_allocation uuid, p_kind text, p_object text, p_amount integer, p_fee integer, p_owner integer, p_detail jsonb
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_a public.owner_rent_allocations%rowtype;
  v_event uuid;
  v_status text;
begin
  select * into v_a from public.owner_rent_allocations where id = p_allocation for update;
  if not found then return jsonb_build_object('applied', false, 'reason', 'no_allocation'); end if;
  insert into public.owner_allocation_events (allocation_id, kind, stripe_object_id, amount_cents, fee_cents, owner_cents, detail)
    values (p_allocation, p_kind, p_object, greatest(p_amount, 0), greatest(p_fee, 0), greatest(p_owner, 0), coalesce(p_detail, '{}'::jsonb))
    on conflict (allocation_id, kind, stripe_object_id) do nothing returning id into v_event;
  if v_event is null then return jsonb_build_object('applied', false, 'reason', 'already_applied'); end if;

  if p_kind = 'refund' then
    if v_a.refunded_principal_cents + p_amount > v_a.principal_cents then
      raise exception 'Refund exceeds the allocated payment';
    end if;
    v_status := case when v_a.refunded_principal_cents + p_amount >= v_a.principal_cents then 'refunded' else 'partially_refunded' end;
    update public.owner_rent_allocations set
      refunded_principal_cents = refunded_principal_cents + p_amount,
      refunded_fee_cents = least(refunded_fee_cents + p_fee, monthly_fee_cents + leasing_fee_cents),
      refunded_owner_cents = refunded_owner_cents + p_owner,
      status = case when status in ('disputed', 'dispute_lost') then status else v_status end,
      updated_at = now() where id = p_allocation;
  elsif p_kind = 'dispute_opened' then
    update public.owner_rent_allocations set disputed_cents = p_amount,
      status = case when status = 'refunded' then status else 'disputed' end, updated_at = now() where id = p_allocation;
  elsif p_kind = 'dispute_lost' then
    update public.owner_rent_allocations set status = 'dispute_lost', updated_at = now() where id = p_allocation;
  elsif p_kind = 'dispute_won' then
    update public.owner_rent_allocations set disputed_cents = 0,
      status = case when refunded_principal_cents >= principal_cents then 'refunded'
                    when refunded_principal_cents > 0 then 'partially_refunded' else 'settled' end,
      updated_at = now() where id = p_allocation;
  end if;
  return jsonb_build_object('applied', true, 'event_id', v_event);
end;
$$;

revoke all on function public.owner_month_totals(uuid, text) from public, anon, authenticated;
revoke all on function public.reserve_owner_fee(uuid, uuid, uuid, text, integer, integer, integer, integer, text, text[], bigint, bigint) from public, anon, authenticated;
revoke all on function public.release_owner_fee_reservation(uuid) from public, anon, authenticated;
revoke all on function public.credit_owner_rent_allocations(uuid, uuid, uuid, uuid, text, text, text, text, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.apply_owner_allocation_event(uuid, text, text, integer, integer, integer, jsonb) from public, anon, authenticated;
grant execute on function public.owner_month_totals(uuid, text) to service_role;
grant execute on function public.reserve_owner_fee(uuid, uuid, uuid, text, integer, integer, integer, integer, text, text[], bigint, bigint) to service_role;
grant execute on function public.release_owner_fee_reservation(uuid) to service_role;
grant execute on function public.credit_owner_rent_allocations(uuid, uuid, uuid, uuid, text, text, text, text, text, text, text, jsonb) to service_role;
grant execute on function public.apply_owner_allocation_event(uuid, text, text, integer, integer, integer, jsonb) to service_role;
