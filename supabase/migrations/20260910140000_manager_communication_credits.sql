-- Prepaid communication: service-role writes only, with atomic per-owner spending.
create table if not exists public.comms_credit_policy (
  singleton boolean primary key default true check (singleton),
  cutover_at timestamptz not null default now()
);
insert into public.comms_credit_policy(singleton) values(true) on conflict do nothing;
alter table public.comms_credit_policy enable row level security;
revoke all on public.comms_credit_policy from anon, authenticated;

alter table public.manager_comms_billing_accounts
  add column if not exists credit_period_start timestamptz,
  add column if not exists included_allowance_cents integer not null default 0,
  add column if not exists included_remaining_cents integer not null default 0,
  add column if not exists purchased_credit_cents integer not null default 0,
  add column if not exists credit_cutover_at timestamptz;

alter table public.manager_comms_usage_events
  add column if not exists credit_state text not null default 'legacy',
  add column if not exists included_debit_cents integer not null default 0,
  add column if not exists purchased_debit_cents integer not null default 0,
  add column if not exists platform_absorbed_cents integer not null default 0,
  add column if not exists credit_period_start timestamptz;
alter table public.manager_comms_usage_events drop constraint if exists comms_usage_credit_state_check;
alter table public.manager_comms_usage_events add constraint comms_usage_credit_state_check
  check (credit_state in ('legacy','reserved','settled','released'));

create table if not exists public.manager_comms_credit_purchases (
  id uuid primary key,
  manager_user_id uuid not null references public.profiles(id) on delete cascade,
  credit_cents integer not null check (credit_cents in (500,1000,2500,5000)),
  stripe_session_id text unique,
  stripe_payment_intent_id text unique,
  status text not null default 'pending' check(status in ('pending','paid','reversed')),
  reversed_cents integer not null default 0 check (reversed_cents >= 0),
  receipt_url text,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  unique(manager_user_id,id)
);
create table if not exists public.manager_comms_credit_adjustments (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid not null references public.manager_comms_credit_purchases(id) on delete cascade,
  manager_user_id uuid not null references public.profiles(id) on delete cascade,
  provider_event_id text not null unique,
  amount_cents integer not null,
  reason text not null,
  created_at timestamptz not null default now()
);
create index if not exists comms_credit_purchases_owner_created on public.manager_comms_credit_purchases(manager_user_id,created_at desc);
alter table public.manager_comms_credit_purchases enable row level security;
alter table public.manager_comms_credit_adjustments enable row level security;
revoke all on public.manager_comms_credit_purchases, public.manager_comms_credit_adjustments from anon, authenticated;

-- GET callers pass p_apply=false: no account creation, billing, or provider writes.
-- Mutation callers lock the account and materialize the same computed snapshot.
create or replace function public.comms_wallet_snapshot(
  p_owner uuid, p_allowance integer, p_legacy_allowance integer, p_apply boolean default false
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  a public.manager_comms_billing_accounts%rowtype;
  period_start timestamptz := date_trunc('month',now() at time zone 'UTC') at time zone 'UTC';
  cutover timestamptz;
  old_account boolean;
  allowance integer;
  remaining integer;
  prior_usage bigint;
begin
  if p_owner is null or p_allowance < 0 or p_allowance > 1000000 or p_legacy_allowance < 0 or p_legacy_allowance > 1000000 then
    raise exception 'Invalid communication allowance';
  end if;
  select cutover_at into strict cutover from public.comms_credit_policy where singleton;
  if p_apply then
    insert into public.manager_comms_billing_accounts(manager_user_id) values(p_owner) on conflict do nothing;
    select * into strict a from public.manager_comms_billing_accounts where manager_user_id=p_owner for update;
  else
    select * into a from public.manager_comms_billing_accounts where manager_user_id=p_owner;
  end if;
  if a.credit_period_start is null then
    select created_at < cutover into old_account from public.profiles where id=p_owner;
    if not found then raise exception 'Communication account not found'; end if;
    allowance := case when old_account and period_start = date_trunc('month',cutover at time zone 'UTC') at time zone 'UTC'
      then greatest(p_allowance,p_legacy_allowance) else p_allowance end;
    select coalesce(sum(total_cents),0) into prior_usage from public.manager_comms_usage_events
      where manager_user_id=p_owner and created_at>=period_start and created_at<period_start+interval '1 month' and credit_state='legacy';
    remaining := greatest(0,allowance-prior_usage)::integer;
  elsif a.credit_period_start <> period_start then
    allowance := p_allowance;
    remaining := p_allowance;
  else
    -- A downgrade never retracts the current month's grant; an upgrade adds
    -- only the positive difference, even across repeated plan changes.
    allowance := greatest(a.included_allowance_cents,p_allowance);
    remaining := a.included_remaining_cents + greatest(0,p_allowance-a.included_allowance_cents);
  end if;
  if p_apply then
    update public.manager_comms_billing_accounts set
      credit_period_start=period_start, included_allowance_cents=allowance, included_remaining_cents=remaining,
      credit_cutover_at=coalesce(credit_cutover_at,now()),
      notified_budget_80_at=case when a.credit_period_start is distinct from period_start then null else notified_budget_80_at end,
      notified_budget_100_at=case when a.credit_period_start is distinct from period_start then null else notified_budget_100_at end,
      updated_at=now()
      where manager_user_id=p_owner;
  end if;
  return jsonb_build_object('allowance_cents',allowance,'included_remaining_cents',remaining,
    'purchased_remaining_cents',greatest(0,coalesce(a.purchased_credit_cents,0)),
    'period_start',period_start,'period_end',period_start+interval '1 month',
    'paused',a.billing_paused_at is not null or coalesce(a.purchased_credit_cents,0)<0,
    'next_allowance_cents',p_allowance);
end $$;

create or replace function public.reserve_comms_credit(
  p_owner uuid, p_allowance integer, p_legacy_allowance integer,
  p_key text, p_meter text, p_quantity numeric, p_unit_cents integer,
  p_metadata jsonb default '{}'::jsonb, p_allow_unfunded boolean default false
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  a public.manager_comms_billing_accounts%rowtype;
  e public.manager_comms_usage_events%rowtype;
  cost integer; included integer; purchased integer; snapshot jsonb;
begin
  if p_key is null or length(p_key)<1 or length(p_key)>300 or p_quantity is null or p_quantity<=0 or p_quantity>1000000
    or p_unit_cents is null or p_unit_cents<0 or p_unit_cents>1000000 then raise exception 'Invalid communication reservation'; end if;
  cost := round(p_quantity*p_unit_cents)::integer;
  snapshot := public.comms_wallet_snapshot(p_owner,p_allowance,p_legacy_allowance,true);
  select * into strict a from public.manager_comms_billing_accounts where manager_user_id=p_owner;
  select * into e from public.manager_comms_usage_events where idempotency_key=p_key;
  if found then
    if e.manager_user_id<>p_owner or e.meter<>p_meter or e.unit_price_cents<>p_unit_cents or e.quantity<>p_quantity then
      raise exception 'Communication reservation identity mismatch';
    end if;
    return jsonb_build_object('allowed',e.credit_state in ('reserved','settled'),'duplicate',true,'state',e.credit_state);
  end if;
  if not p_allow_unfunded and (a.billing_paused_at is not null or a.purchased_credit_cents<0) then
    return jsonb_build_object('allowed',false,'reason','billing_paused');
  end if;
  if not p_allow_unfunded and cost>a.included_remaining_cents+greatest(0,a.purchased_credit_cents) then
    return jsonb_build_object('allowed',false,'reason','allowance_exhausted');
  end if;
  included := least(cost,a.included_remaining_cents);
  purchased := least(cost-included,greatest(0,a.purchased_credit_cents));
  insert into public.manager_comms_usage_events(manager_user_id,meter,quantity,unit_price_cents,total_cents,idempotency_key,
      metadata,credit_state,included_debit_cents,purchased_debit_cents,platform_absorbed_cents,credit_period_start)
    values(p_owner,p_meter,p_quantity,p_unit_cents,cost,p_key,p_metadata,
      case when p_allow_unfunded then 'settled' else 'reserved' end,included,purchased,cost-included-purchased,a.credit_period_start);
  update public.manager_comms_billing_accounts set included_remaining_cents=included_remaining_cents-included,
    purchased_credit_cents=purchased_credit_cents-purchased,updated_at=now() where manager_user_id=p_owner;
  return jsonb_build_object('allowed',true,'duplicate',false,'state',case when p_allow_unfunded then 'settled' else 'reserved' end);
end $$;

-- Unknown provider outcomes remain reserved. Only a known pre-dispatch failure
-- releases a reservation. Old-period included credit is never rolled forward.
create or replace function public.finish_comms_credit(p_owner uuid,p_key text,p_release boolean default false)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.manager_comms_billing_accounts%rowtype; e public.manager_comms_usage_events%rowtype;
begin
  select * into a from public.manager_comms_billing_accounts where manager_user_id=p_owner for update;
  select * into e from public.manager_comms_usage_events where manager_user_id=p_owner and idempotency_key=p_key for update;
  if not found then return false; end if;
  if e.credit_state <> 'reserved' then return e.credit_state='settled' or (p_release and e.credit_state='released'); end if;
  if p_release then
    update public.manager_comms_billing_accounts set
      included_remaining_cents=included_remaining_cents+case when credit_period_start=e.credit_period_start then e.included_debit_cents else 0 end,
      purchased_credit_cents=purchased_credit_cents+e.purchased_debit_cents,updated_at=now() where manager_user_id=p_owner;
  end if;
  update public.manager_comms_usage_events set credit_state=case when p_release then 'released' else 'settled' end
    where id=e.id;
  return true;
end $$;

create or replace function public.fulfill_comms_credit_purchase(
  p_purchase uuid,p_owner uuid,p_session text,p_payment_intent text,p_credit integer,p_event text,p_receipt text default null
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare purchase public.manager_comms_credit_purchases%rowtype;
begin
  insert into public.manager_comms_billing_accounts(manager_user_id) values(p_owner) on conflict do nothing;
  perform 1 from public.manager_comms_billing_accounts where manager_user_id=p_owner for update;
  select * into strict purchase from public.manager_comms_credit_purchases where id=p_purchase and manager_user_id=p_owner for update;
  if purchase.credit_cents<>p_credit or (purchase.stripe_session_id is not null and purchase.stripe_session_id<>p_session)
    or (purchase.stripe_payment_intent_id is not null and purchase.stripe_payment_intent_id<>p_payment_intent)
    or p_session is null or p_payment_intent is null or p_event is null then raise exception 'Credit purchase mismatch'; end if;
  if purchase.status<>'pending' then return false; end if;
  update public.manager_comms_credit_purchases set status='paid',stripe_session_id=p_session,
    stripe_payment_intent_id=p_payment_intent,paid_at=now(),receipt_url=p_receipt where id=p_purchase;
  insert into public.manager_comms_credit_adjustments(purchase_id,manager_user_id,provider_event_id,amount_cents,reason)
    values(p_purchase,p_owner,p_event,p_credit,'purchase');
  update public.manager_comms_billing_accounts set purchased_credit_cents=purchased_credit_cents+p_credit,updated_at=now()
    where manager_user_id=p_owner;
  return true;
end $$;

-- p_reversed is the authoritative cumulative refund/dispute amount expressed
-- in credit cents. Monotonic accounting tolerates duplicate/out-of-order events.
create or replace function public.reverse_comms_credit_purchase(p_payment_intent text,p_reversed integer,p_event text,p_reason text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare purchase public.manager_comms_credit_purchases%rowtype; delta integer;
begin
  select * into purchase from public.manager_comms_credit_purchases where stripe_payment_intent_id=p_payment_intent;
  if not found then return false; end if;
  perform 1 from public.manager_comms_billing_accounts where manager_user_id=purchase.manager_user_id for update;
  select * into strict purchase from public.manager_comms_credit_purchases where id=purchase.id for update;
  delta := greatest(0,least(purchase.credit_cents,p_reversed)-purchase.reversed_cents);
  if delta=0 then return false; end if;
  insert into public.manager_comms_credit_adjustments(purchase_id,manager_user_id,provider_event_id,amount_cents,reason)
    values(purchase.id,purchase.manager_user_id,p_event,-delta,p_reason) on conflict(provider_event_id) do nothing;
  if not found then return false; end if;
  update public.manager_comms_credit_purchases set reversed_cents=reversed_cents+delta,
    status=case when reversed_cents+delta=credit_cents then 'reversed' else status end where id=purchase.id;
  update public.manager_comms_billing_accounts set purchased_credit_cents=purchased_credit_cents-delta,
    billing_paused_at=case when purchased_credit_cents-delta<0 or p_reason='dispute' then coalesce(billing_paused_at,now()) else billing_paused_at end,
    billing_pause_reason=case when purchased_credit_cents-delta<0 or p_reason='dispute' then 'credit_reversal_review' else billing_pause_reason end,
    updated_at=now() where manager_user_id=purchase.manager_user_id;
  return true;
end $$;

revoke all on function public.comms_wallet_snapshot(uuid,integer,integer,boolean) from public,anon,authenticated;
revoke all on function public.reserve_comms_credit(uuid,integer,integer,text,text,numeric,integer,jsonb,boolean) from public,anon,authenticated;
revoke all on function public.finish_comms_credit(uuid,text,boolean) from public,anon,authenticated;
revoke all on function public.fulfill_comms_credit_purchase(uuid,uuid,text,text,integer,text,text) from public,anon,authenticated;
revoke all on function public.reverse_comms_credit_purchase(text,integer,text,text) from public,anon,authenticated;
grant execute on function public.comms_wallet_snapshot(uuid,integer,integer,boolean) to service_role;
grant execute on function public.reserve_comms_credit(uuid,integer,integer,text,text,numeric,integer,jsonb,boolean) to service_role;
grant execute on function public.finish_comms_credit(uuid,text,boolean) to service_role;
grant execute on function public.fulfill_comms_credit_purchase(uuid,uuid,text,text,integer,text,text) to service_role;
grant execute on function public.reverse_comms_credit_purchase(text,integer,text,text) to service_role;

-- Settle a bounded call against provider-reported duration and return unused credit.
create or replace function public.settle_comms_credit_quantity(p_owner uuid,p_key text,p_quantity numeric)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare e public.manager_comms_usage_events%rowtype; cost integer; refund integer; purchased_refund integer;
begin
  if p_quantity is null or p_quantity<0 then raise exception 'Invalid settlement quantity'; end if;
  perform 1 from public.manager_comms_billing_accounts where manager_user_id=p_owner for update;
  select * into e from public.manager_comms_usage_events where manager_user_id=p_owner and idempotency_key=p_key for update;
  if not found then return false; end if;
  if e.credit_state='settled' or e.credit_state='released' then return true; end if;
  if e.credit_state<>'reserved' then return false; end if;
  -- The call was bounded before answering. A provider overrun is absorbed, never debt.
  cost := least(e.total_cents,round(p_quantity*e.unit_price_cents)::integer);
  refund := e.total_cents-cost;
  purchased_refund := least(refund,e.purchased_debit_cents);
  update public.manager_comms_billing_accounts set
    purchased_credit_cents=purchased_credit_cents+purchased_refund,
    included_remaining_cents=included_remaining_cents+case when credit_period_start=e.credit_period_start then refund-purchased_refund else 0 end,
    updated_at=now() where manager_user_id=p_owner;
  update public.manager_comms_usage_events set quantity=p_quantity,total_cents=round(p_quantity*e.unit_price_cents)::integer,
    platform_absorbed_cents=greatest(0,round(p_quantity*e.unit_price_cents)::integer-cost),
    purchased_debit_cents=purchased_debit_cents-purchased_refund,
    included_debit_cents=included_debit_cents-(refund-purchased_refund),
    credit_state=case when p_quantity=0 then 'released' else 'settled' end where id=e.id;
  return true;
end $$;
revoke all on function public.settle_comms_credit_quantity(uuid,text,numeric) from public,anon,authenticated;
grant execute on function public.settle_comms_credit_quantity(uuid,text,numeric) to service_role;

alter table public.manager_comms_usage_events drop constraint if exists manager_comms_usage_events_quantity_check;
alter table public.manager_comms_usage_events add constraint manager_comms_usage_events_quantity_check
  check(quantity>0 or (quantity=0 and credit_state='released'));

alter table public.manager_automation_settings add column if not exists manual_payments jsonb not null default '{}'::jsonb;
update public.manager_automation_settings set manual_payments=row_data->'manualPayments'
  where manual_payments='{}'::jsonb and jsonb_typeof(row_data->'manualPayments')='object';

-- Both writers serialize on the settings row. A manager save can never restore
-- an earlier staff approval, even when it overlaps a staff revocation.
create or replace function public.save_manager_payment_preferences(p_owner uuid,p_settings jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare current_settings jsonb; next_settings jsonb;
begin
  if p_owner is null or jsonb_typeof(p_settings)<>'object' then raise exception 'Invalid payment settings'; end if;
  insert into public.manager_automation_settings(manager_user_id) values(p_owner) on conflict do nothing;
  select manual_payments into strict current_settings from public.manager_automation_settings where manager_user_id=p_owner for update;
  next_settings := p_settings-'adminServiceFeeOverride'-'serviceFeeWaiverCode';
  if current_settings ? 'adminServiceFeeOverride' then
    next_settings := next_settings || jsonb_build_object('adminServiceFeeOverride',current_settings->'adminServiceFeeOverride');
  end if;
  if next_settings->>'serviceFeePayer'='proplane' and coalesce(current_settings->>'adminServiceFeeOverride','')<>'proplane' then
    next_settings := jsonb_set(next_settings,'{serviceFeePayer}','"resident"'::jsonb);
  end if;
  update public.manager_automation_settings set manual_payments=next_settings,updated_at=now() where manager_user_id=p_owner;
  return next_settings;
end $$;
create or replace function public.set_staff_payment_fee_override(p_owner uuid,p_override text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare next_settings jsonb;
begin
  if p_owner is null or (p_override is not null and p_override not in ('resident','manager','proplane')) then raise exception 'Invalid fee override'; end if;
  insert into public.manager_automation_settings(manager_user_id) values(p_owner) on conflict do nothing;
  select manual_payments-'adminServiceFeeOverride' into strict next_settings from public.manager_automation_settings where manager_user_id=p_owner for update;
  if p_override is not null then next_settings := next_settings || jsonb_build_object('adminServiceFeeOverride',p_override); end if;
  update public.manager_automation_settings set manual_payments=next_settings,updated_at=now() where manager_user_id=p_owner;
  return next_settings;
end $$;
revoke all on function public.save_manager_payment_preferences(uuid,jsonb) from public,anon,authenticated;
revoke all on function public.set_staff_payment_fee_override(uuid,text) from public,anon,authenticated;
grant execute on function public.save_manager_payment_preferences(uuid,jsonb) to service_role;
grant execute on function public.set_staff_payment_fee_override(uuid,text) to service_role;

grant all on public.comms_credit_policy,public.manager_comms_credit_purchases,public.manager_comms_credit_adjustments to service_role;
