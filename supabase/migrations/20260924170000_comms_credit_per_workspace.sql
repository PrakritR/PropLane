-- Communication credit is per WORKSPACE, not per account.
--
-- `manager_comms_billing_accounts` keeps what belongs to the OWNER: the Stripe
-- customer, the billing pause, the alert threshold and its monthly claims. The
-- spendable balance moves to `manager_comms_workspace_wallets`, keyed
-- (manager_user_id, workspace_id), so the owner and every accepted co-manager
-- messaging from a workspace spend that workspace's own credit.
--
-- The plan's included monthly credit belongs to the owner's DEFAULT workspace
-- alone (`portal_workspaces.is_default`). A second workspace spends purchased
-- credit only and rolls over to zero included credit; otherwise buying a
-- workspace would multiply the plan's included allowance.
--
-- Existing balances move onto the owner's default workspace wallet, and the
-- three balance columns on the account row are zeroed so no reader can spend
-- the same money twice.

create table if not exists public.manager_comms_workspace_wallets (
  manager_user_id uuid not null references public.profiles(id) on delete cascade,
  workspace_id uuid not null references public.portal_workspaces(id) on delete cascade,
  credit_period_start timestamptz,
  included_allowance_cents integer not null default 0,
  included_remaining_cents integer not null default 0,
  purchased_credit_cents integer not null default 0,
  credit_cutover_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (manager_user_id, workspace_id)
);
create index if not exists manager_comms_workspace_wallets_workspace_idx
  on public.manager_comms_workspace_wallets(workspace_id);
alter table public.manager_comms_workspace_wallets enable row level security;
revoke all on public.manager_comms_workspace_wallets from anon, authenticated;
grant all on public.manager_comms_workspace_wallets to service_role;

-- The ledger columns carry no foreign key on purpose: spend history and paid
-- purchases must survive a workspace being deleted, and neither RESTRICT (which
-- would make any workspace with one text undeletable) nor CASCADE (which would
-- erase paid history) is acceptable for a financial record.
alter table public.manager_comms_credit_purchases add column if not exists workspace_id uuid;
alter table public.manager_comms_usage_events add column if not exists workspace_id uuid;

do $comms_workspace_backfill$
declare r record;
begin
  -- Every owner with a communication account gets their default workspace now,
  -- so no existing balance is stranded without a wallet to hold it.
  for r in select manager_user_id from public.manager_comms_billing_accounts loop
    perform public.ensure_default_portal_workspace(r.manager_user_id);
  end loop;
  for r in select distinct manager_user_id from public.manager_comms_usage_events where workspace_id is null loop
    update public.manager_comms_usage_events
      set workspace_id = public.ensure_default_portal_workspace(r.manager_user_id)
      where manager_user_id = r.manager_user_id and workspace_id is null;
  end loop;
  for r in select distinct manager_user_id from public.manager_comms_credit_purchases where workspace_id is null loop
    update public.manager_comms_credit_purchases
      set workspace_id = public.ensure_default_portal_workspace(r.manager_user_id)
      where manager_user_id = r.manager_user_id and workspace_id is null;
  end loop;
end
$comms_workspace_backfill$;

alter table public.manager_comms_usage_events alter column workspace_id set not null;
alter table public.manager_comms_credit_purchases alter column workspace_id set not null;
create index if not exists manager_comms_usage_events_workspace_created_idx
  on public.manager_comms_usage_events(workspace_id, created_at desc);
create index if not exists comms_credit_purchases_workspace_created
  on public.manager_comms_credit_purchases(workspace_id, created_at desc);

insert into public.manager_comms_workspace_wallets(
  manager_user_id, workspace_id, credit_period_start, included_allowance_cents,
  included_remaining_cents, purchased_credit_cents, credit_cutover_at)
select a.manager_user_id, w.id, a.credit_period_start, a.included_allowance_cents,
  a.included_remaining_cents, a.purchased_credit_cents, a.credit_cutover_at
from public.manager_comms_billing_accounts a
join public.portal_workspaces w on w.owner_user_id = a.manager_user_id and w.is_default
on conflict (manager_user_id, workspace_id) do nothing;

-- The account row keeps `credit_period_start` as the alert-claim period marker
-- only. The three balance columns are retired; the wallets own the money.
update public.manager_comms_billing_accounts set
  included_allowance_cents = 0, included_remaining_cents = 0,
  purchased_credit_cents = 0, updated_at = now()
where included_allowance_cents <> 0 or included_remaining_cents <> 0
  or purchased_credit_cents <> 0;

-- Deleting a workspace must not silently burn purchased credit. Included credit
-- is this month's grant and is not transferable; purchased credit follows the
-- owner to the oldest workspace they still hold.
create or replace function public.fold_comms_wallet_on_workspace_delete()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare leftover integer; destination uuid;
begin
  select purchased_credit_cents into leftover from public.manager_comms_workspace_wallets
    where manager_user_id=old.owner_user_id and workspace_id=old.id for update;
  if leftover is null or leftover = 0 then return old; end if;
  select id into destination from public.portal_workspaces
    where owner_user_id=old.owner_user_id and id<>old.id order by created_at, id limit 1;
  if destination is null then return old; end if;
  insert into public.manager_comms_workspace_wallets(manager_user_id,workspace_id)
    values(old.owner_user_id,destination) on conflict do nothing;
  update public.manager_comms_workspace_wallets
    set purchased_credit_cents=purchased_credit_cents+leftover, updated_at=now()
    where manager_user_id=old.owner_user_id and workspace_id=destination;
  return old;
end $$;
revoke all on function public.fold_comms_wallet_on_workspace_delete() from public, anon, authenticated;
drop trigger if exists comms_wallet_fold_on_delete on public.portal_workspaces;
create trigger comms_wallet_fold_on_delete before delete on public.portal_workspaces
for each row execute function public.fold_comms_wallet_on_workspace_delete();

-- GET callers pass p_apply=false: no account, wallet, billing or provider
-- writes. Mutation callers lock the account, then the wallet, then the event —
-- one lock order for every function in this file.
create or replace function public.comms_wallet_snapshot(
  p_owner uuid, p_workspace uuid, p_allowance integer, p_legacy_allowance integer, p_apply boolean default false
) returns jsonb language plpgsql security definer set search_path=public,pg_temp set timezone='UTC' as $$
declare
  w public.manager_comms_workspace_wallets%rowtype;
  acct public.manager_comms_billing_accounts%rowtype;
  period_start timestamptz := date_trunc('month',now() at time zone 'UTC') at time zone 'UTC';
  cutover timestamptz;
  default_workspace boolean;
  old_account boolean;
  allowance integer;
  remaining integer;
  prior_usage bigint;
begin
  if p_owner is null or p_workspace is null or p_allowance < 0 or p_allowance > 1000000
    or p_legacy_allowance < 0 or p_legacy_allowance > 1000000 then
    raise exception 'Invalid communication allowance';
  end if;
  select cutover_at into strict cutover from public.comms_credit_policy where singleton;
  -- A workspace id in a request is never authorization. The wallet exists only
  -- for a workspace this owner actually owns.
  select pw.is_default into default_workspace from public.portal_workspaces pw
    where pw.id=p_workspace and pw.owner_user_id=p_owner;
  if default_workspace is null then raise exception 'Communication workspace not found'; end if;
  if p_apply then
    insert into public.manager_comms_billing_accounts(manager_user_id) values(p_owner) on conflict do nothing;
    select * into strict acct from public.manager_comms_billing_accounts where manager_user_id=p_owner for update;
    insert into public.manager_comms_workspace_wallets(manager_user_id,workspace_id)
      values(p_owner,p_workspace) on conflict do nothing;
    select * into strict w from public.manager_comms_workspace_wallets
      where manager_user_id=p_owner and workspace_id=p_workspace for update;
  else
    select * into acct from public.manager_comms_billing_accounts where manager_user_id=p_owner;
    select * into w from public.manager_comms_workspace_wallets
      where manager_user_id=p_owner and workspace_id=p_workspace;
  end if;
  if not default_workspace then
    -- Only the default workspace receives the plan's included monthly credit.
    allowance := 0;
    remaining := 0;
  elsif w.credit_period_start is null then
    select created_at < cutover into old_account from public.profiles where id=p_owner;
    if not found then raise exception 'Communication account not found'; end if;
    allowance := case when old_account and period_start = date_trunc('month',cutover at time zone 'UTC') at time zone 'UTC'
      then greatest(p_allowance,p_legacy_allowance) else p_allowance end;
    select coalesce(sum(total_cents),0) into prior_usage from public.manager_comms_usage_events
      where manager_user_id=p_owner and workspace_id=p_workspace
        and created_at>=period_start and created_at<period_start+interval '1 month' and credit_state='legacy';
    remaining := greatest(0,allowance-prior_usage)::integer;
  elsif w.credit_period_start <> period_start then
    allowance := p_allowance;
    remaining := p_allowance;
  else
    -- A downgrade never retracts the current month's grant; an upgrade adds
    -- only the positive difference, even across repeated plan changes.
    allowance := greatest(w.included_allowance_cents,p_allowance);
    remaining := w.included_remaining_cents + greatest(0,p_allowance-w.included_allowance_cents);
  end if;
  if p_apply then
    update public.manager_comms_workspace_wallets set
      credit_period_start=period_start, included_allowance_cents=allowance, included_remaining_cents=remaining,
      credit_cutover_at=coalesce(credit_cutover_at,now()), updated_at=now()
      where manager_user_id=p_owner and workspace_id=p_workspace;
    -- Alert claims reset with the included period, which only the default
    -- workspace rolls over.
    if default_workspace then
      update public.manager_comms_billing_accounts set
        credit_period_start=period_start,
        credit_cutover_at=coalesce(credit_cutover_at,now()),
        notified_budget_80_at=case when acct.credit_period_start is distinct from period_start then null else notified_budget_80_at end,
        notified_budget_100_at=case when acct.credit_period_start is distinct from period_start then null else notified_budget_100_at end,
        updated_at=now()
        where manager_user_id=p_owner;
    end if;
  end if;
  return jsonb_build_object('allowance_cents',allowance,'included_remaining_cents',remaining,
    'purchased_remaining_cents',greatest(0,coalesce(w.purchased_credit_cents,0)),
    'period_start',period_start,'period_end',period_start+interval '1 month',
    'paused',acct.billing_paused_at is not null or coalesce(w.purchased_credit_cents,0)<0,
    'workspace_id',p_workspace,'is_default_workspace',default_workspace,
    'next_allowance_cents',case when default_workspace then p_allowance else 0 end);
end $$;

-- Backward compatibility for callers that still name an owner alone. A
-- read-only snapshot never creates a workspace.
create or replace function public.comms_wallet_snapshot(
  p_owner uuid, p_allowance integer, p_legacy_allowance integer, p_apply boolean default false
) returns jsonb language plpgsql security definer set search_path=public,pg_temp set timezone='UTC' as $$
declare ws uuid;
begin
  if p_apply then
    ws := public.ensure_default_portal_workspace(p_owner);
  else
    select id into ws from public.portal_workspaces where owner_user_id=p_owner and is_default;
    if ws is null then raise exception 'Communication workspace not found'; end if;
  end if;
  return public.comms_wallet_snapshot(p_owner,ws,p_allowance,p_legacy_allowance,p_apply);
end $$;

create or replace function public.reserve_comms_credit(
  p_owner uuid, p_workspace uuid, p_allowance integer, p_legacy_allowance integer,
  p_key text, p_meter text, p_quantity numeric, p_unit_cents integer,
  p_metadata jsonb default '{}'::jsonb, p_allow_unfunded boolean default false
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  w public.manager_comms_workspace_wallets%rowtype;
  acct public.manager_comms_billing_accounts%rowtype;
  e public.manager_comms_usage_events%rowtype;
  cost integer; included integer; purchased integer; snapshot jsonb;
begin
  if p_key is null or length(p_key)<1 or length(p_key)>300 or p_quantity is null or p_quantity<=0 or p_quantity>1000000
    or p_unit_cents is null or p_unit_cents<0 or p_unit_cents>1000000 then raise exception 'Invalid communication reservation'; end if;
  cost := round(p_quantity*p_unit_cents)::integer;
  snapshot := public.comms_wallet_snapshot(p_owner,p_workspace,p_allowance,p_legacy_allowance,true);
  select * into strict acct from public.manager_comms_billing_accounts where manager_user_id=p_owner;
  select * into strict w from public.manager_comms_workspace_wallets
    where manager_user_id=p_owner and workspace_id=p_workspace;
  select * into e from public.manager_comms_usage_events where idempotency_key=p_key;
  if found then
    -- The workspace is deliberately NOT part of this identity test. The first
    -- attempt already debited one exact wallet, and this branch moves no money;
    -- a retry whose sending workspace has since changed must still replay as a
    -- duplicate rather than block the message forever.
    if e.manager_user_id<>p_owner or e.meter<>p_meter or e.unit_price_cents<>p_unit_cents or e.quantity<>p_quantity then
      raise exception 'Communication reservation identity mismatch';
    end if;
    return jsonb_build_object('allowed',e.credit_state in ('reserved','settled'),'duplicate',true,'state',e.credit_state);
  end if;
  if not p_allow_unfunded and (acct.billing_paused_at is not null or w.purchased_credit_cents<0) then
    return jsonb_build_object('allowed',false,'reason','billing_paused');
  end if;
  if not p_allow_unfunded and cost>w.included_remaining_cents+greatest(0,w.purchased_credit_cents) then
    return jsonb_build_object('allowed',false,'reason','allowance_exhausted');
  end if;
  included := least(cost,w.included_remaining_cents);
  purchased := least(cost-included,greatest(0,w.purchased_credit_cents));
  insert into public.manager_comms_usage_events(manager_user_id,workspace_id,meter,quantity,unit_price_cents,total_cents,
      idempotency_key,metadata,credit_state,included_debit_cents,purchased_debit_cents,platform_absorbed_cents,credit_period_start)
    values(p_owner,p_workspace,p_meter,p_quantity,p_unit_cents,cost,p_key,p_metadata,
      case when p_allow_unfunded then 'settled' else 'reserved' end,included,purchased,cost-included-purchased,w.credit_period_start);
  update public.manager_comms_workspace_wallets set included_remaining_cents=included_remaining_cents-included,
    purchased_credit_cents=purchased_credit_cents-purchased,updated_at=now()
    where manager_user_id=p_owner and workspace_id=p_workspace;
  return jsonb_build_object('allowed',true,'duplicate',false,'state',case when p_allow_unfunded then 'settled' else 'reserved' end);
end $$;

create or replace function public.reserve_comms_credit(
  p_owner uuid, p_allowance integer, p_legacy_allowance integer,
  p_key text, p_meter text, p_quantity numeric, p_unit_cents integer,
  p_metadata jsonb default '{}'::jsonb, p_allow_unfunded boolean default false
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin
  return public.reserve_comms_credit(p_owner,public.ensure_default_portal_workspace(p_owner),
    p_allowance,p_legacy_allowance,p_key,p_meter,p_quantity,p_unit_cents,p_metadata,p_allow_unfunded);
end $$;

-- Unknown provider outcomes remain reserved. Only a known pre-dispatch failure
-- releases a reservation. Old-period included credit is never rolled forward.
-- The release returns credit to the wallet the reservation actually debited,
-- read from the event — never to a wallet a caller names, so the refund stays
-- exact even after the sender's workspace assignment changes.
create or replace function public.finish_comms_credit(p_owner uuid,p_key text,p_release boolean default false)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare e public.manager_comms_usage_events%rowtype; ws uuid;
begin
  select workspace_id into ws from public.manager_comms_usage_events
    where manager_user_id=p_owner and idempotency_key=p_key;
  if ws is null then return false; end if;
  perform 1 from public.manager_comms_billing_accounts where manager_user_id=p_owner for update;
  perform 1 from public.manager_comms_workspace_wallets
    where manager_user_id=p_owner and workspace_id=ws for update;
  select * into e from public.manager_comms_usage_events
    where manager_user_id=p_owner and idempotency_key=p_key for update;
  if not found then return false; end if;
  if e.credit_state <> 'reserved' then return e.credit_state='settled' or (p_release and e.credit_state='released'); end if;
  if p_release then
    update public.manager_comms_workspace_wallets set
      included_remaining_cents=included_remaining_cents+case when credit_period_start=e.credit_period_start then e.included_debit_cents else 0 end,
      purchased_credit_cents=purchased_credit_cents+e.purchased_debit_cents,updated_at=now()
      where manager_user_id=p_owner and workspace_id=e.workspace_id;
  end if;
  update public.manager_comms_usage_events set credit_state=case when p_release then 'released' else 'settled' end
    where id=e.id;
  return true;
end $$;

-- Settle a bounded call against provider-reported duration and return unused
-- credit to the same workspace wallet the reservation debited.
create or replace function public.settle_comms_credit_quantity(p_owner uuid,p_key text,p_quantity numeric)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare e public.manager_comms_usage_events%rowtype; ws uuid;
  cost integer; refund integer; purchased_refund integer;
begin
  if p_quantity is null or p_quantity<0 then raise exception 'Invalid settlement quantity'; end if;
  select workspace_id into ws from public.manager_comms_usage_events
    where manager_user_id=p_owner and idempotency_key=p_key;
  if ws is null then return false; end if;
  perform 1 from public.manager_comms_billing_accounts where manager_user_id=p_owner for update;
  perform 1 from public.manager_comms_workspace_wallets
    where manager_user_id=p_owner and workspace_id=ws for update;
  select * into e from public.manager_comms_usage_events
    where manager_user_id=p_owner and idempotency_key=p_key for update;
  if not found then return false; end if;
  if e.credit_state='settled' or e.credit_state='released' then return true; end if;
  if e.credit_state<>'reserved' then return false; end if;
  -- The call was bounded before answering. A provider overrun is absorbed, never debt.
  cost := least(e.total_cents,round(p_quantity*e.unit_price_cents)::integer);
  refund := e.total_cents-cost;
  purchased_refund := least(refund,e.purchased_debit_cents);
  update public.manager_comms_workspace_wallets set
    purchased_credit_cents=purchased_credit_cents+purchased_refund,
    included_remaining_cents=included_remaining_cents+case when credit_period_start=e.credit_period_start then refund-purchased_refund else 0 end,
    updated_at=now() where manager_user_id=p_owner and workspace_id=e.workspace_id;
  update public.manager_comms_usage_events set quantity=p_quantity,total_cents=round(p_quantity*e.unit_price_cents)::integer,
    platform_absorbed_cents=greatest(0,round(p_quantity*e.unit_price_cents)::integer-cost),
    purchased_debit_cents=purchased_debit_cents-purchased_refund,
    included_debit_cents=included_debit_cents-(refund-purchased_refund),
    credit_state=case when p_quantity=0 then 'released' else 'settled' end where id=e.id;
  return true;
end $$;

-- The purchase row carries the workspace the buyer chose at checkout; the
-- webhook never takes it from provider metadata. A workspace deleted between
-- checkout and fulfillment falls back to the owner's default wallet so paid
-- credit is never dropped.
create or replace function public.fulfill_comms_credit_purchase(
  p_purchase uuid,p_owner uuid,p_session text,p_payment_intent text,p_credit integer,p_event text,p_receipt text default null
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare purchase public.manager_comms_credit_purchases%rowtype; ws uuid;
begin
  insert into public.manager_comms_billing_accounts(manager_user_id) values(p_owner) on conflict do nothing;
  perform 1 from public.manager_comms_billing_accounts where manager_user_id=p_owner for update;
  select workspace_id into ws from public.manager_comms_credit_purchases
    where id=p_purchase and manager_user_id=p_owner;
  if ws is null then raise exception 'Credit purchase mismatch'; end if;
  if not exists(select 1 from public.portal_workspaces where id=ws and owner_user_id=p_owner) then
    ws := public.ensure_default_portal_workspace(p_owner);
  end if;
  insert into public.manager_comms_workspace_wallets(manager_user_id,workspace_id)
    values(p_owner,ws) on conflict do nothing;
  perform 1 from public.manager_comms_workspace_wallets
    where manager_user_id=p_owner and workspace_id=ws for update;
  select * into strict purchase from public.manager_comms_credit_purchases where id=p_purchase and manager_user_id=p_owner for update;
  if purchase.credit_cents<>p_credit or (purchase.stripe_session_id is not null and purchase.stripe_session_id<>p_session)
    or (purchase.stripe_payment_intent_id is not null and purchase.stripe_payment_intent_id<>p_payment_intent)
    or p_session is null or p_payment_intent is null or p_event is null then raise exception 'Credit purchase mismatch'; end if;
  if purchase.status<>'pending' then return false; end if;
  update public.manager_comms_credit_purchases set status='paid',stripe_session_id=p_session,
    stripe_payment_intent_id=p_payment_intent,paid_at=now(),receipt_url=p_receipt where id=p_purchase;
  insert into public.manager_comms_credit_adjustments(purchase_id,manager_user_id,provider_event_id,amount_cents,reason)
    values(p_purchase,p_owner,p_event,p_credit,'purchase');
  update public.manager_comms_workspace_wallets set purchased_credit_cents=purchased_credit_cents+p_credit,updated_at=now()
    where manager_user_id=p_owner and workspace_id=ws;
  return true;
end $$;

-- p_reversed is the authoritative cumulative refund/dispute amount expressed
-- in credit cents. Monotonic accounting tolerates duplicate/out-of-order events.
-- The reversal debits the same workspace wallet the purchase credited; the pause
-- stays on the owner's account row, where every wallet reads it.
create or replace function public.reverse_comms_credit_purchase(p_payment_intent text,p_reversed integer,p_event text,p_reason text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare purchase public.manager_comms_credit_purchases%rowtype; delta integer; ws uuid; remaining integer;
begin
  select * into purchase from public.manager_comms_credit_purchases where stripe_payment_intent_id=p_payment_intent;
  if not found then return false; end if;
  perform 1 from public.manager_comms_billing_accounts where manager_user_id=purchase.manager_user_id for update;
  ws := purchase.workspace_id;
  if ws is null or not exists(select 1 from public.portal_workspaces where id=ws and owner_user_id=purchase.manager_user_id) then
    ws := public.ensure_default_portal_workspace(purchase.manager_user_id);
  end if;
  insert into public.manager_comms_workspace_wallets(manager_user_id,workspace_id)
    values(purchase.manager_user_id,ws) on conflict do nothing;
  perform 1 from public.manager_comms_workspace_wallets
    where manager_user_id=purchase.manager_user_id and workspace_id=ws for update;
  select * into strict purchase from public.manager_comms_credit_purchases where id=purchase.id for update;
  delta := greatest(0,least(purchase.credit_cents,p_reversed)-purchase.reversed_cents);
  if delta=0 then return false; end if;
  insert into public.manager_comms_credit_adjustments(purchase_id,manager_user_id,provider_event_id,amount_cents,reason)
    values(purchase.id,purchase.manager_user_id,p_event,-delta,p_reason) on conflict(provider_event_id) do nothing;
  if not found then return false; end if;
  update public.manager_comms_credit_purchases set reversed_cents=reversed_cents+delta,
    status=case when reversed_cents+delta=credit_cents then 'reversed' else status end where id=purchase.id;
  update public.manager_comms_workspace_wallets set purchased_credit_cents=purchased_credit_cents-delta,updated_at=now()
    where manager_user_id=purchase.manager_user_id and workspace_id=ws
    returning purchased_credit_cents into remaining;
  update public.manager_comms_billing_accounts set
    billing_paused_at=case when coalesce(remaining,0)<0 or p_reason='dispute' then coalesce(billing_paused_at,now()) else billing_paused_at end,
    billing_pause_reason=case when coalesce(remaining,0)<0 or p_reason='dispute' then 'credit_reversal_review' else billing_pause_reason end,
    updated_at=now() where manager_user_id=purchase.manager_user_id;
  return true;
end $$;

-- Read-only bulk wallet view for staff screens: one round trip for many owners,
-- each computed by the canonical comms_wallet_snapshot with p_apply=false.
-- Never creates accounts, workspaces, resets periods, or grants credit. An
-- explicit `workspace` per request overrides the owner's default.
drop function if exists public.comms_wallet_snapshots(jsonb);
create or replace function public.comms_wallet_snapshots(p_requests jsonb)
returns table(manager_user_id uuid, workspace_id uuid, snapshot jsonb)
language plpgsql security definer set search_path=public,pg_temp set timezone='UTC' as $$
declare r jsonb;
begin
  if p_requests is null or jsonb_typeof(p_requests)<>'array' or jsonb_array_length(p_requests)>500 then
    raise exception 'Invalid wallet snapshot request';
  end if;
  for r in select value from jsonb_array_elements(p_requests) loop
    manager_user_id := (r->>'owner')::uuid;
    workspace_id := null;
    snapshot := null;
    begin
      workspace_id := coalesce(
        nullif(r->>'workspace','')::uuid,
        (select pw.id from public.portal_workspaces pw
          where pw.owner_user_id=manager_user_id and pw.is_default));
      if workspace_id is not null then
        snapshot := public.comms_wallet_snapshot(manager_user_id,workspace_id,
          (r->>'allowance')::integer,(r->>'legacy_allowance')::integer,false);
      end if;
    exception when others then
      snapshot := null;
    end;
    return next;
  end loop;
end $$;

-- The workspace a send spends from is the workspace of the work number it
-- leaves on — the same row `resolveOwnerSendNumberRow` picks in the dispatcher.
create or replace function public.comms_send_workspace_for_number(p_owner uuid,p_phone text)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare ws uuid;
begin
  select n.workspace_id into ws from public.manager_sms_numbers n
    where n.manager_user_id=p_owner and n.phone_number=p_phone and n.workspace_id is not null
    limit 1;
  if ws is null then ws := public.ensure_default_portal_workspace(p_owner); end if;
  return ws;
end $$;

revoke all on function public.comms_wallet_snapshot(uuid,uuid,integer,integer,boolean) from public,anon,authenticated;
revoke all on function public.comms_wallet_snapshot(uuid,integer,integer,boolean) from public,anon,authenticated;
revoke all on function public.comms_wallet_snapshots(jsonb) from public,anon,authenticated;
revoke all on function public.reserve_comms_credit(uuid,uuid,integer,integer,text,text,numeric,integer,jsonb,boolean) from public,anon,authenticated;
revoke all on function public.reserve_comms_credit(uuid,integer,integer,text,text,numeric,integer,jsonb,boolean) from public,anon,authenticated;
revoke all on function public.finish_comms_credit(uuid,text,boolean) from public,anon,authenticated;
revoke all on function public.settle_comms_credit_quantity(uuid,text,numeric) from public,anon,authenticated;
revoke all on function public.fulfill_comms_credit_purchase(uuid,uuid,text,text,integer,text,text) from public,anon,authenticated;
revoke all on function public.reverse_comms_credit_purchase(text,integer,text,text) from public,anon,authenticated;
revoke all on function public.comms_send_workspace_for_number(uuid,text) from public,anon,authenticated;
grant execute on function public.comms_wallet_snapshot(uuid,uuid,integer,integer,boolean) to service_role;
grant execute on function public.comms_wallet_snapshot(uuid,integer,integer,boolean) to service_role;
grant execute on function public.comms_wallet_snapshots(jsonb) to service_role;
grant execute on function public.reserve_comms_credit(uuid,uuid,integer,integer,text,text,numeric,integer,jsonb,boolean) to service_role;
grant execute on function public.reserve_comms_credit(uuid,integer,integer,text,text,numeric,integer,jsonb,boolean) to service_role;
grant execute on function public.finish_comms_credit(uuid,text,boolean) to service_role;
grant execute on function public.settle_comms_credit_quantity(uuid,text,numeric) to service_role;
grant execute on function public.fulfill_comms_credit_purchase(uuid,uuid,text,text,integer,text,text) to service_role;
grant execute on function public.reverse_comms_credit_purchase(text,integer,text,text) to service_role;
grant execute on function public.comms_send_workspace_for_number(uuid,text) to service_role;

-- Both autonomous prospect-SMS submission paths reserve credit inside their own
-- fenced transaction. They keep their exact signatures and now spend from the
-- workspace that owns the work number the message leaves on, resolved from the
-- provider from-phone they already receive.
create or replace function public.begin_prospect_tour_booking_confirmation_submission_v2(
  p_booking_id uuid,
  p_outbox_id uuid,
  p_outbox_worker_id text,
  p_attempt_id uuid,
  p_dispatch_started_at timestamptz,
  p_allowance integer,
  p_legacy_allowance integer,
  p_unit_cents integer,
  p_provider_from_phone text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_booking public.prospect_tour_bookings;
  v_outbox public.sms_outbox;
  v_burst public.prospect_sms_bursts;
  v_events jsonb;
  v_event jsonb;
  v_budget_available boolean;
  v_credit jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('proplane:confirmed-tour-schedule', 0));
  select * into v_booking from public.prospect_tour_bookings where id=p_booking_id for update;
  if not found then return jsonb_build_object('outcome','unavailable','costs_reserved',false); end if;

  -- The booking always owns the burst identity, even when recovery created the
  -- outbox before the normal worker attached burst metadata to it. Locking the
  -- burst before the outbox makes the two preparation orders converge.
  if v_booking.burst_id is not null then
    select * into v_burst from public.prospect_sms_bursts where id=v_booking.burst_id for update;
    if not found then return jsonb_build_object('outcome','unavailable','costs_reserved',false); end if;
  end if;

  select * into v_outbox from public.sms_outbox where id=p_outbox_id for update;
  if not found
    or v_outbox.status is distinct from 'claimed'
    or v_outbox.lease_owner is distinct from p_outbox_worker_id
    or v_outbox.lease_expires_at is null
    or v_outbox.lease_expires_at<=p_dispatch_started_at
    or v_outbox.prospect_tour_booking_confirmation_id is distinct from p_booking_id then
    return jsonb_build_object('outcome','unavailable','costs_reserved',false);
  end if;
  perform 1 from public.sms_delivery_attempts
    where id=p_attempt_id and outbox_id=p_outbox_id and state='submitting';
  if not found then return jsonb_build_object('outcome','unavailable','costs_reserved',false); end if;

  select coalesce(row_data->'payload','[]'::jsonb) into v_events
    from public.portal_schedule_records where id='axis_admin_planned_events_v1' for update;
  select value into v_event from jsonb_array_elements(coalesce(v_events,'[]'::jsonb)) value
    where value->>'id'=v_booking.planned_event_id;
  if v_booking.status is distinct from 'confirmed'
    or v_event is null
    or coalesce(v_event->>'canceledAt','')<>''
    or v_event->>'start' is distinct from v_booking.event_snapshot->>'start'
    or v_event->>'end' is distinct from v_booking.event_snapshot->>'end'
    or v_event->>'slotKey' is distinct from v_booking.event_snapshot->>'slotKey' then
    update public.sms_outbox set status='blocked',blocked_reason='prospect_tour_confirmation_stale',
      lease_owner=null,lease_expires_at=null,updated_at=now() where id=p_outbox_id;
    update public.prospect_tour_bookings set confirmation_status='blocked',updated_at=now()
      where id=p_booking_id and confirmation_outbox_id=p_outbox_id;
    update public.sms_delivery_attempts set state='pre_dispatch_failed',finished_at=now()
      where id=p_attempt_id and outbox_id=p_outbox_id;
    return jsonb_build_object('outcome','stale','costs_reserved',false);
  end if;

  if v_outbox.prospect_burst_id is not null then
    if v_outbox.prospect_burst_id is distinct from v_booking.burst_id
      or v_outbox.prospect_burst_revision is distinct from v_booking.burst_revision
      or v_burst.revision is distinct from v_booking.burst_revision
      or v_burst.status is distinct from 'prepared'
      or v_burst.outbox_id is distinct from v_outbox.id then
      update public.sms_outbox set status='blocked',blocked_reason='prospect_tour_confirmation_stale',
        lease_owner=null,lease_expires_at=null,updated_at=now() where id=p_outbox_id;
      update public.prospect_tour_bookings set confirmation_status='blocked',updated_at=now()
        where id=p_booking_id;
      update public.sms_delivery_attempts set state='pre_dispatch_failed',finished_at=now()
        where id=p_attempt_id and outbox_id=p_outbox_id;
      return jsonb_build_object('outcome','stale','costs_reserved',false);
    end if;
  end if;

  -- Roll back both reservations on any refusal. A retry sees neither a partial
  -- credit debit nor a spent campaign segment.
  begin
    v_credit := public.reserve_comms_credit(
      v_outbox.manager_user_id,
      public.comms_send_workspace_for_number(v_outbox.manager_user_id,p_provider_from_phone),
      p_allowance,
      p_legacy_allowance,
      'sms_outbound:' || v_outbox.id::text,
      'sms_outbound_segment',
      v_outbox.segment_count,
      p_unit_cents,
      jsonb_build_object('outboxId',v_outbox.id)
    );
    if coalesce((v_credit->>'allowed')::boolean,false) is not true then
      raise exception using errcode='P0001', message='credit_' || coalesce(v_credit->>'reason','unavailable');
    end if;
    if coalesce((v_credit->>'duplicate')::boolean,false) and v_credit->>'state'<>'reserved' then
      raise exception using errcode='P0001', message='credit_already_settled';
    end if;
    select public.spend_sms_segment_budget(v_outbox.segment_count) into v_budget_available;
    if v_budget_available is distinct from true then
      raise exception using errcode='P0001', message='budget_exhausted';
    end if;

    if v_outbox.prospect_burst_id is not null then
      update public.prospect_sms_bursts set
        status='dispatched',
        handled_revision=v_burst.revision,
        outbox_id=v_outbox.id,
        candidate_body=v_outbox.body,
        lease_owner=null,
        lease_expires_at=null,
        history_snapshot=v_burst.candidate_context,
        candidate_context=null,
        candidate_shadow_snapshot=null,
        updated_at=now()
      where id=v_burst.id;
      if v_burst.candidate_shadow_snapshot is not null then
        insert into public.prospect_sms_shadow_jobs(burst_id,burst_revision,manager_user_id,snapshot)
        values(v_burst.id,v_burst.revision,v_burst.manager_user_id,v_burst.candidate_shadow_snapshot)
        on conflict(burst_id,burst_revision) do nothing;
      end if;
    end if;
  exception
    when sqlstate 'P0001' then
      return jsonb_build_object('outcome',SQLERRM,'costs_reserved',false);
    when others then
      return jsonb_build_object('outcome','credit_unavailable','costs_reserved',false);
  end;

  update public.sms_outbox set
    status='submitting',
    dispatch_started_at=p_dispatch_started_at,
    provider_from_phone=p_provider_from_phone,
    updated_at=p_dispatch_started_at
  where id=p_outbox_id;
  return jsonb_build_object('outcome','started','costs_reserved',true);
end; $$;

create or replace function public.begin_sms_outbox_submission(
  p_outbox_id uuid,
  p_outbox_worker_id text,
  p_attempt_id uuid,
  p_dispatch_started_at timestamptz,
  p_allowance integer,
  p_legacy_allowance integer,
  p_unit_cents integer,
  p_provider_from_phone text
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_outbox public.sms_outbox;
  v_burst public.prospect_sms_bursts;
  v_booking_id uuid;
  v_budget_available boolean;
  v_burst_id uuid;
  v_burst_revision integer;
  v_credit jsonb;
begin
  select prospect_burst_id,prospect_burst_revision
    into v_burst_id,v_burst_revision from public.sms_outbox where id=p_outbox_id;
  if not found then return 'unavailable'; end if;
  if v_burst_id is not null then
    select id into v_booking_id from public.prospect_tour_bookings
      where burst_id=v_burst_id and burst_revision=v_burst_revision for update;
    select * into v_burst from public.prospect_sms_bursts where id=v_burst_id for update;
    if not found then return 'unavailable'; end if;
  end if;
  select * into v_outbox from public.sms_outbox where id=p_outbox_id for update;
  if not found
    or v_outbox.status<>'claimed'
    or v_outbox.lease_owner<>p_outbox_worker_id
    or v_outbox.lease_expires_at<=p_dispatch_started_at then
    return 'unavailable';
  end if;
  if v_booking_id is not null then
    update public.sms_outbox set prospect_tour_booking_confirmation_id=v_booking_id,updated_at=now()
      where id=p_outbox_id and prospect_tour_booking_confirmation_id is null;
    update public.prospect_tour_bookings set
      confirmation_outbox_id=p_outbox_id,
      confirmation_status='prepared',
      updated_at=now()
    where id=v_booking_id;
    return 'booking_required';
  end if;
  if v_outbox.prospect_burst_id is not null then
    if v_outbox.prospect_burst_id<>v_burst_id
      or v_burst.revision<>v_outbox.prospect_burst_revision
      or v_burst.status<>'prepared'
      or v_burst.outbox_id<>v_outbox.id then
      update public.sms_outbox set status='blocked',blocked_reason='prospect_burst_stale',
        lease_owner=null,lease_expires_at=null,updated_at=now() where id=p_outbox_id;
      update public.sms_delivery_attempts set state='pre_dispatch_failed',finished_at=now()
        where id=p_attempt_id and outbox_id=p_outbox_id;
      return 'stale';
    end if;
    begin
      v_credit := public.reserve_comms_credit(
        v_outbox.manager_user_id,
        public.comms_send_workspace_for_number(v_outbox.manager_user_id,p_provider_from_phone),
        p_allowance,p_legacy_allowance,
        'sms_outbound:' || v_outbox.id::text,'sms_outbound_segment',
        v_outbox.segment_count,p_unit_cents,jsonb_build_object('outboxId',v_outbox.id)
      );
      if coalesce((v_credit->>'allowed')::boolean,false) is not true then
        raise exception using errcode='P0001', message='credit_' || coalesce(v_credit->>'reason','unavailable');
      end if;
      if coalesce((v_credit->>'duplicate')::boolean,false) and v_credit->>'state'<>'reserved' then
        raise exception using errcode='P0001', message='credit_already_settled';
      end if;
      select public.spend_sms_segment_budget(v_outbox.segment_count) into v_budget_available;
      if v_budget_available is distinct from true then
        raise exception using errcode='P0001', message='budget_exhausted';
      end if;
      update public.prospect_sms_bursts set
        status='dispatched',handled_revision=v_burst.revision,outbox_id=v_outbox.id,
        candidate_body=v_outbox.body,lease_owner=null,lease_expires_at=null,
        history_snapshot=v_burst.candidate_context,candidate_context=null,
        candidate_shadow_snapshot=null,updated_at=now()
      where id=v_burst.id;
      if v_burst.candidate_shadow_snapshot is not null then
        insert into public.prospect_sms_shadow_jobs(burst_id,burst_revision,manager_user_id,snapshot)
        values(v_burst.id,v_burst.revision,v_burst.manager_user_id,v_burst.candidate_shadow_snapshot)
        on conflict(burst_id,burst_revision) do nothing;
      end if;
    exception
      when sqlstate 'P0001' then return SQLERRM;
      when others then return 'credit_unavailable';
    end;
  end if;
  update public.sms_outbox set
    status='submitting',dispatch_started_at=p_dispatch_started_at,
    provider_from_phone=p_provider_from_phone,updated_at=p_dispatch_started_at
  where id=p_outbox_id;
  return 'started';
end; $$;

revoke execute on function public.begin_prospect_tour_booking_confirmation_submission_v2(
  uuid,uuid,text,uuid,timestamptz,integer,integer,integer,text
) from public, anon, authenticated;
grant execute on function public.begin_prospect_tour_booking_confirmation_submission_v2(
  uuid,uuid,text,uuid,timestamptz,integer,integer,integer,text
) to service_role;
revoke execute on function public.begin_sms_outbox_submission(
  uuid,text,uuid,timestamptz,integer,integer,integer,text
) from public, anon, authenticated;
grant execute on function public.begin_sms_outbox_submission(
  uuid,text,uuid,timestamptz,integer,integer,integer,text
) to service_role;
