-- PropLane Number: a $5/month subscription for a vendor or resident (their own work number
-- plus $3.00 of message credit every UTC calendar month, spent first), and a credit ledger
-- for that owner. Additive and idempotent: safe to re-run, touches no existing table.
--
-- Money rules (docs/agents/comms-billing.md § PropLane Number):
--   * Every table here is written ONLY by the service role (a route pinned to the caller's
--     own user id, or the signed Stripe webhook). Client roles get SELECT on their own
--     subscription row (non-secret columns only) and nothing else.
--   * Credit is reserved BEFORE any provider/model work; a saved card never authorizes a
--     charge and there is no auto-recharge.
--   * The included $3.00 exists only while the subscription is `active`; purchased credit
--     never expires. Reversals (refund/dispute) are idempotent per provider event id.

create table if not exists public.number_subscriptions (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null unique references auth.users(id) on delete cascade,
  owner_role text not null check (owner_role in ('vendor', 'resident')),
  stripe_customer_id text,
  stripe_subscription_id text unique,
  status text not null default 'incomplete' check (status in ('active', 'past_due', 'canceled', 'incomplete')),
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  -- Stripe event time of the last applied change; an older event never overwrites a newer one.
  last_event_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.number_subscriptions enable row level security;
revoke all on public.number_subscriptions from anon, authenticated;
grant all on public.number_subscriptions to service_role;
-- Own row, non-secret columns only: no Stripe ids reach the client.
grant select (owner_user_id, owner_role, status, current_period_end, cancel_at_period_end, created_at, updated_at)
  on public.number_subscriptions to authenticated;
drop policy if exists number_subscriptions_select_own on public.number_subscriptions;
create policy number_subscriptions_select_own on public.number_subscriptions
  for select to authenticated using (owner_user_id = (select auth.uid()));

-- One row per credit owner. `included_period_start` is the UTC month the included grant was
-- issued for (null = never granted).
create table if not exists public.number_credit_accounts (
  owner_user_id uuid primary key references auth.users(id) on delete cascade,
  included_remaining_cents integer not null default 0 check (included_remaining_cents >= 0),
  included_period_start date,
  purchased_credit_cents integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.number_credit_usage_events (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  meter text not null,
  quantity numeric not null check (quantity >= 0),
  unit_price_cents integer not null check (unit_price_cents >= 0),
  total_cents integer not null check (total_cents >= 0),
  idempotency_key text not null unique,
  credit_state text not null check (credit_state in ('reserved', 'settled', 'released')),
  included_debit_cents integer not null default 0 check (included_debit_cents >= 0),
  purchased_debit_cents integer not null default 0 check (purchased_debit_cents >= 0),
  platform_absorbed_cents integer not null default 0 check (platform_absorbed_cents >= 0),
  credit_period_start date,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists number_credit_usage_events_owner_created
  on public.number_credit_usage_events(owner_user_id, created_at desc);

create table if not exists public.number_credit_purchases (
  id uuid primary key,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  credit_cents integer not null check (credit_cents >= 500 and credit_cents <= 50000 and credit_cents % 100 = 0),
  stripe_session_id text unique,
  stripe_payment_intent_id text unique,
  status text not null default 'pending' check (status in ('pending', 'paid', 'reversed')),
  reversed_cents integer not null default 0 check (reversed_cents >= 0),
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  unique (owner_user_id, id)
);
create index if not exists number_credit_purchases_owner_created
  on public.number_credit_purchases(owner_user_id, created_at desc);

create table if not exists public.number_credit_adjustments (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid not null references public.number_credit_purchases(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  provider_event_id text not null unique,
  amount_cents integer not null,
  reason text not null,
  created_at timestamptz not null default now()
);

alter table public.number_credit_accounts enable row level security;
alter table public.number_credit_usage_events enable row level security;
alter table public.number_credit_purchases enable row level security;
alter table public.number_credit_adjustments enable row level security;
revoke all on public.number_credit_accounts, public.number_credit_usage_events,
  public.number_credit_purchases, public.number_credit_adjustments from anon, authenticated;
grant all on public.number_credit_accounts, public.number_credit_usage_events,
  public.number_credit_purchases, public.number_credit_adjustments to service_role;

-- ---------------------------------------------------------------------------------------
-- Subscription state. Called only by the signed webhook, with the subscription as freshly
-- re-read from Stripe; p_event_at is the time of that read. Returns 'applied' or why nothing changed ('stale', 'customer_mismatch',
-- 'other_subscription'), so a replay or an out-of-order event is a harmless no-op.
-- ---------------------------------------------------------------------------------------
create or replace function public.apply_number_subscription_event(
  p_owner uuid,
  p_role text,
  p_customer text,
  p_subscription text,
  p_status text,
  p_period_end timestamptz,
  p_cancel_at_period_end boolean,
  p_event_at timestamptz
) returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare cur public.number_subscriptions%rowtype;
begin
  if p_owner is null or p_customer is null or length(p_customer) < 1 or p_subscription is null
    or length(p_subscription) < 1 or p_event_at is null
    or p_role not in ('vendor', 'resident')
    or p_status not in ('active', 'past_due', 'canceled', 'incomplete') then
    raise exception 'Invalid number subscription event';
  end if;
  insert into public.number_subscriptions(owner_user_id, owner_role, stripe_customer_id, status)
    values (p_owner, p_role, p_customer, 'incomplete')
    on conflict (owner_user_id) do nothing;
  select * into cur from public.number_subscriptions where owner_user_id = p_owner for update;
  if cur.stripe_customer_id is not null and cur.stripe_customer_id <> p_customer then
    return 'customer_mismatch';
  end if;
  -- A live subscription is never replaced, and a stale subscription's events never touch it.
  if cur.stripe_subscription_id is not null and cur.stripe_subscription_id <> p_subscription
    and cur.status in ('active', 'past_due') then
    return 'other_subscription';
  end if;
  if cur.last_event_at is not null and cur.last_event_at > p_event_at then
    return 'stale';
  end if;
  update public.number_subscriptions set
    stripe_customer_id = p_customer,
    stripe_subscription_id = p_subscription,
    status = p_status,
    current_period_end = coalesce(p_period_end, current_period_end),
    cancel_at_period_end = coalesce(p_cancel_at_period_end, false),
    last_event_at = p_event_at,
    updated_at = now()
    where owner_user_id = p_owner;
  return 'applied';
end $$;

-- ---------------------------------------------------------------------------------------
-- Credit. The included grant is a property of (active subscription, UTC month): it resets on
-- the 1st at 00:00 UTC, never rolls over, and exists only while status = 'active'.
-- ---------------------------------------------------------------------------------------
create or replace function public.number_credit_snapshot(
  p_owner uuid,
  p_included_cents integer,
  p_apply boolean default false
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  acct public.number_credit_accounts%rowtype;
  sub_status text;
  cur_month date := (date_trunc('month', now() at time zone 'utc'))::date;
  is_active boolean;
begin
  if p_owner is null or p_included_cents is null or p_included_cents < 0 or p_included_cents > 100000 then
    raise exception 'Invalid number credit snapshot';
  end if;
  select status into sub_status from public.number_subscriptions where owner_user_id = p_owner;
  is_active := coalesce(sub_status, '') = 'active';
  if p_apply then
    insert into public.number_credit_accounts(owner_user_id) values (p_owner) on conflict do nothing;
    select * into acct from public.number_credit_accounts where owner_user_id = p_owner for update;
    if is_active and (acct.included_period_start is null or acct.included_period_start < cur_month) then
      update public.number_credit_accounts set
        included_remaining_cents = p_included_cents, included_period_start = cur_month, updated_at = now()
        where owner_user_id = p_owner
        returning * into acct;
    end if;
  else
    select * into acct from public.number_credit_accounts where owner_user_id = p_owner;
    if not found then
      acct.owner_user_id := p_owner;
      acct.included_remaining_cents := 0;
      acct.included_period_start := null;
      acct.purchased_credit_cents := 0;
    end if;
    if is_active and (acct.included_period_start is null or acct.included_period_start < cur_month) then
      acct.included_remaining_cents := p_included_cents;
      acct.included_period_start := cur_month;
    end if;
  end if;
  return jsonb_build_object(
    'subscription_status', sub_status,
    'active', is_active,
    'included_remaining_cents', case when is_active then acct.included_remaining_cents else 0 end,
    'purchased_cents', greatest(0, acct.purchased_credit_cents),
    'period_start', cur_month,
    'next_reset', (cur_month + interval '1 month')::date
  );
end $$;

create or replace function public.reserve_number_credit(
  p_owner uuid,
  p_key text,
  p_meter text,
  p_quantity numeric,
  p_unit_cents integer,
  p_included_cents integer,
  p_metadata jsonb default '{}'::jsonb,
  p_allow_unfunded boolean default false
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  cost integer;
  e public.number_credit_usage_events%rowtype;
  acct public.number_credit_accounts%rowtype;
  snap jsonb;
  sub_status text;
  entitled boolean;
  avail_included integer;
  avail_purchased integer;
  d_included integer;
  d_purchased integer;
begin
  if p_owner is null or p_key is null or length(p_key) < 1 or length(p_key) > 300
    or p_meter is null or length(p_meter) < 1
    or p_quantity is null or p_quantity <= 0 or p_quantity > 1000000
    or p_unit_cents is null or p_unit_cents < 0 or p_unit_cents > 1000000 then
    raise exception 'Invalid number credit reservation';
  end if;
  cost := round(p_quantity * p_unit_cents)::integer;

  -- The account row is the lock every reserve/finish/fulfil for this owner serialises on.
  insert into public.number_credit_accounts(owner_user_id) values (p_owner) on conflict do nothing;
  perform 1 from public.number_credit_accounts where owner_user_id = p_owner for update;

  select * into e from public.number_credit_usage_events where idempotency_key = p_key;
  if found then
    if e.owner_user_id <> p_owner or e.meter <> p_meter or e.unit_price_cents <> p_unit_cents or e.quantity <> p_quantity then
      raise exception 'Number credit reservation identity mismatch';
    end if;
    return jsonb_build_object('allowed', e.credit_state in ('reserved', 'settled'), 'duplicate', true, 'state', e.credit_state);
  end if;

  snap := public.number_credit_snapshot(p_owner, p_included_cents, true);
  select * into acct from public.number_credit_accounts where owner_user_id = p_owner;
  sub_status := snap ->> 'subscription_status';
  entitled := coalesce(sub_status, '') in ('active', 'past_due');
  avail_included := (snap ->> 'included_remaining_cents')::integer;
  avail_purchased := case when entitled then greatest(0, acct.purchased_credit_cents) else 0 end;

  if cost > avail_included + avail_purchased and not p_allow_unfunded then
    return jsonb_build_object('allowed', false,
      'reason', case when entitled then 'allowance_exhausted' else 'subscription_inactive' end);
  end if;

  -- Included credit is spent first.
  d_included := least(cost, avail_included);
  d_purchased := least(cost - d_included, avail_purchased);

  insert into public.number_credit_usage_events(owner_user_id, meter, quantity, unit_price_cents, total_cents,
      idempotency_key, credit_state, included_debit_cents, purchased_debit_cents, platform_absorbed_cents,
      credit_period_start, metadata)
    values (p_owner, p_meter, p_quantity, p_unit_cents, cost, p_key,
      case when p_allow_unfunded then 'settled' else 'reserved' end,
      d_included, d_purchased, cost - d_included - d_purchased,
      acct.included_period_start, coalesce(p_metadata, '{}'::jsonb));

  update public.number_credit_accounts set
    included_remaining_cents = included_remaining_cents - d_included,
    purchased_credit_cents = purchased_credit_cents - d_purchased,
    updated_at = now()
    where owner_user_id = p_owner;

  return jsonb_build_object('allowed', true, 'duplicate', false,
    'state', case when p_allow_unfunded then 'settled' else 'reserved' end);
end $$;

-- Settle (keep the debit) or release (return it) a reservation. Returns to the SAME buckets it
-- came out of; included credit only comes back inside the month it was spent in.
create or replace function public.finish_number_credit(p_owner uuid, p_key text, p_release boolean default false)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.number_credit_usage_events%rowtype;
begin
  perform 1 from public.number_credit_accounts where owner_user_id = p_owner for update;
  if not found then return false; end if;
  select * into e from public.number_credit_usage_events
    where owner_user_id = p_owner and idempotency_key = p_key for update;
  if not found then return false; end if;
  if e.credit_state <> 'reserved' then
    return e.credit_state = 'settled' or (p_release and e.credit_state = 'released');
  end if;
  if p_release then
    update public.number_credit_accounts set
      included_remaining_cents = included_remaining_cents
        + case when included_period_start is not distinct from e.credit_period_start then e.included_debit_cents else 0 end,
      purchased_credit_cents = purchased_credit_cents + e.purchased_debit_cents,
      updated_at = now()
      where owner_user_id = p_owner;
  end if;
  update public.number_credit_usage_events
    set credit_state = case when p_release then 'released' else 'settled' end
    where id = e.id;
  return true;
end $$;

create or replace function public.settle_number_credit_quantity(p_owner uuid, p_key text, p_quantity numeric)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  e public.number_credit_usage_events%rowtype;
  new_total integer;
  refund integer;
  purchased_refund integer;
  included_refund integer;
begin
  if p_quantity is null or p_quantity < 0 then raise exception 'Invalid settlement quantity'; end if;
  perform 1 from public.number_credit_accounts where owner_user_id = p_owner for update;
  if not found then return false; end if;
  select * into e from public.number_credit_usage_events
    where owner_user_id = p_owner and idempotency_key = p_key for update;
  if not found then return false; end if;
  if e.credit_state in ('settled', 'released') then return true; end if;
  new_total := least(e.total_cents, round(p_quantity * e.unit_price_cents)::integer);
  refund := e.total_cents - new_total;
  -- Last in, first out: the purchased bucket was debited last, so it is refunded first.
  purchased_refund := least(refund, e.purchased_debit_cents);
  included_refund := least(refund - purchased_refund, e.included_debit_cents);
  update public.number_credit_accounts set
    purchased_credit_cents = purchased_credit_cents + purchased_refund,
    included_remaining_cents = included_remaining_cents
      + case when included_period_start is not distinct from e.credit_period_start then included_refund else 0 end,
    updated_at = now()
    where owner_user_id = p_owner;
  update public.number_credit_usage_events set
    quantity = p_quantity,
    total_cents = new_total,
    purchased_debit_cents = purchased_debit_cents - purchased_refund,
    included_debit_cents = included_debit_cents - included_refund,
    platform_absorbed_cents = greatest(0, platform_absorbed_cents - (refund - purchased_refund - included_refund)),
    credit_state = case when p_quantity = 0 then 'released' else 'settled' end
    where id = e.id;
  return true;
end $$;

create or replace function public.fulfill_number_credit_purchase(
  p_purchase uuid, p_owner uuid, p_session text, p_payment_intent text, p_credit integer, p_event text
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare purchase public.number_credit_purchases%rowtype;
begin
  if p_purchase is null or p_owner is null or p_session is null or p_payment_intent is null or p_event is null then
    raise exception 'Credit purchase mismatch';
  end if;
  insert into public.number_credit_accounts(owner_user_id) values (p_owner) on conflict do nothing;
  perform 1 from public.number_credit_accounts where owner_user_id = p_owner for update;
  select * into strict purchase from public.number_credit_purchases
    where id = p_purchase and owner_user_id = p_owner for update;
  if purchase.credit_cents <> p_credit
    or (purchase.stripe_session_id is not null and purchase.stripe_session_id <> p_session)
    or (purchase.stripe_payment_intent_id is not null and purchase.stripe_payment_intent_id <> p_payment_intent) then
    raise exception 'Credit purchase mismatch';
  end if;
  if purchase.status <> 'pending' then return false; end if;
  update public.number_credit_purchases set status = 'paid', stripe_session_id = p_session,
    stripe_payment_intent_id = p_payment_intent, paid_at = now() where id = p_purchase;
  insert into public.number_credit_adjustments(purchase_id, owner_user_id, provider_event_id, amount_cents, reason)
    values (p_purchase, p_owner, p_event, p_credit, 'purchase');
  update public.number_credit_accounts set purchased_credit_cents = purchased_credit_cents + p_credit, updated_at = now()
    where owner_user_id = p_owner;
  return true;
end $$;

create or replace function public.reverse_number_credit_purchase(
  p_payment_intent text, p_reversed integer, p_event text, p_reason text
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare purchase public.number_credit_purchases%rowtype; delta integer;
begin
  select * into purchase from public.number_credit_purchases where stripe_payment_intent_id = p_payment_intent;
  if not found then return false; end if;
  perform 1 from public.number_credit_accounts where owner_user_id = purchase.owner_user_id for update;
  select * into strict purchase from public.number_credit_purchases where id = purchase.id for update;
  delta := greatest(0, least(purchase.credit_cents, p_reversed) - purchase.reversed_cents);
  if delta = 0 then return false; end if;
  insert into public.number_credit_adjustments(purchase_id, owner_user_id, provider_event_id, amount_cents, reason)
    values (purchase.id, purchase.owner_user_id, p_event, -delta, p_reason)
    on conflict (provider_event_id) do nothing;
  if not found then return false; end if;
  update public.number_credit_purchases set reversed_cents = reversed_cents + delta,
    status = case when reversed_cents + delta = credit_cents then 'reversed' else status end
    where id = purchase.id;
  -- May go negative: reserve treats a negative purchased balance as zero until it is topped up.
  update public.number_credit_accounts set purchased_credit_cents = purchased_credit_cents - delta, updated_at = now()
    where owner_user_id = purchase.owner_user_id;
  return true;
end $$;

revoke all on function public.apply_number_subscription_event(uuid, text, text, text, text, timestamptz, boolean, timestamptz) from public, anon, authenticated;
revoke all on function public.number_credit_snapshot(uuid, integer, boolean) from public, anon, authenticated;
revoke all on function public.reserve_number_credit(uuid, text, text, numeric, integer, integer, jsonb, boolean) from public, anon, authenticated;
revoke all on function public.finish_number_credit(uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.settle_number_credit_quantity(uuid, text, numeric) from public, anon, authenticated;
revoke all on function public.fulfill_number_credit_purchase(uuid, uuid, text, text, integer, text) from public, anon, authenticated;
revoke all on function public.reverse_number_credit_purchase(text, integer, text, text) from public, anon, authenticated;
grant execute on function public.apply_number_subscription_event(uuid, text, text, text, text, timestamptz, boolean, timestamptz) to service_role;
grant execute on function public.number_credit_snapshot(uuid, integer, boolean) to service_role;
grant execute on function public.reserve_number_credit(uuid, text, text, numeric, integer, integer, jsonb, boolean) to service_role;
grant execute on function public.finish_number_credit(uuid, text, boolean) to service_role;
grant execute on function public.settle_number_credit_quantity(uuid, text, numeric) to service_role;
grant execute on function public.fulfill_number_credit_purchase(uuid, uuid, text, text, integer, text) to service_role;
grant execute on function public.reverse_number_credit_purchase(text, integer, text, text) to service_role;
