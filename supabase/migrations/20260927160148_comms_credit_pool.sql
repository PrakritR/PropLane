-- Messaging-credit pool (S27). Additive only: every table and function here is
-- NEW. The existing per-(owner,workspace) wallet
-- (`manager_comms_workspace_wallets`, `comms_wallet_snapshot`,
-- `reserve_comms_credit`, `finish_comms_credit`, `settle_comms_credit_quantity`,
-- `manager_comms_credit_purchases`) is untouched and stays fully readable and
-- writable exactly as before. The application dispatches between the two
-- models at the TypeScript layer on `COMMS_CREDIT_POOL_ENABLED`
-- (`src/lib/comms-billing/wallet.server.ts`); with that flag off, nothing
-- below is ever called.
--
-- The captain's model (2026-09-27): credit overflows between every workspace
-- a person funds; a per-workspace monthly limit can cap that; adding credit
-- or upgrading a plan defaults to funding every workspace someone is under
-- unless they pin it to one; PropLane admin sets each plan's included credit,
-- whether it is shared across workspaces, and whether unused credit rolls
-- over.
--
-- Shape:
--   comms_plan_credit_rules   admin-editable per-tier defaults (seeded from
--                             RATE_CARD; admin edits survive a re-run of this
--                             file because the seed uses ON CONFLICT DO NOTHING).
--   comms_account_pools       one row per FUNDER (not per workspace): their
--                             plan's included allowance + purchased credit.
--   comms_workspace_funding   which workspaces a funder's pool pays for, and
--                             an optional per-workspace monthly cap.
--   comms_funder_workspace_spend  running per-(funder,workspace,period) spend,
--                             so a monthly limit can be enforced without
--                             scanning the usage ledger on every reservation.
--   comms_pool_credit_purchases / comms_pool_credit_adjustments  Stripe
--                             purchases that land in a funder's account pool
--                             (parallel to, never mixed with, the existing
--                             per-workspace `manager_comms_credit_purchases`).
--
-- `manager_comms_usage_events` gets one new nullable column, `funder_user_id`:
-- null on every legacy/per-workspace-wallet row, set to the paying funder on a
-- pool reservation, so a refund always returns to the exact pool that paid
-- even if the sender's funding configuration changes later.

create table if not exists public.comms_plan_credit_rules (
  tier text primary key check (tier in ('free','pro','business')),
  included_cents integer not null default 0 check (included_cents >= 0),
  shared_across_workspaces boolean not null default true,
  rolls_over boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table public.comms_plan_credit_rules enable row level security;
revoke all on public.comms_plan_credit_rules from anon, authenticated;
grant all on public.comms_plan_credit_rules to service_role;

-- Seeded once from today's RATE_CARD (`src/lib/billing/rate-card.ts`). An
-- admin edit through the Plan credit table is never overwritten by a re-run:
-- ON CONFLICT DO NOTHING only fills a row that does not exist yet.
insert into public.comms_plan_credit_rules(tier, included_cents, shared_across_workspaces, rolls_over) values
  ('free', 0, false, false),
  ('pro', 2500, true, false),
  ('business', 15000, true, false)
on conflict (tier) do nothing;

create table if not exists public.comms_account_pools (
  funder_user_id uuid primary key references public.profiles(id) on delete cascade,
  credit_period_start timestamptz,
  included_allowance_cents integer not null default 0,
  included_remaining_cents integer not null default 0,
  purchased_credit_cents integer not null default 0,
  credit_cutover_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.comms_account_pools enable row level security;
revoke all on public.comms_account_pools from anon, authenticated;
grant all on public.comms_account_pools to service_role;

create table if not exists public.comms_workspace_funding (
  funder_user_id uuid not null references public.profiles(id) on delete cascade,
  workspace_id uuid not null references public.portal_workspaces(id) on delete cascade,
  monthly_limit_cents integer check (monthly_limit_cents is null or monthly_limit_cents >= 0),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (funder_user_id, workspace_id)
);
create index if not exists comms_workspace_funding_workspace_idx
  on public.comms_workspace_funding(workspace_id) where enabled;
alter table public.comms_workspace_funding enable row level security;
revoke all on public.comms_workspace_funding from anon, authenticated;
grant all on public.comms_workspace_funding to service_role;

-- Default funding scope for every existing owner is "all my workspaces": one
-- enabled, unlimited row per workspace they already own. Re-running this file
-- never resets a funder's own later choice (ON CONFLICT DO NOTHING).
insert into public.comms_workspace_funding(funder_user_id, workspace_id, enabled)
select owner_user_id, id, true from public.portal_workspaces
on conflict (funder_user_id, workspace_id) do nothing;

create table if not exists public.comms_funder_workspace_spend (
  funder_user_id uuid not null,
  workspace_id uuid not null,
  period_start timestamptz not null,
  spent_cents integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (funder_user_id, workspace_id, period_start)
);
alter table public.comms_funder_workspace_spend enable row level security;
revoke all on public.comms_funder_workspace_spend from anon, authenticated;
grant all on public.comms_funder_workspace_spend to service_role;

-- Which funder's pool actually paid for a reservation, so a refund/release
-- returns to that exact pool. Null on every event the legacy per-workspace
-- wallet reserved — this column is additive and never backfilled.
alter table public.manager_comms_usage_events
  add column if not exists funder_user_id uuid;
create index if not exists manager_comms_usage_events_funder_idx
  on public.manager_comms_usage_events(funder_user_id, workspace_id, credit_period_start)
  where funder_user_id is not null;

-- Purchases that land in a funder's account pool. Kept as its own table
-- (rather than reusing `manager_comms_credit_purchases`, whose `workspace_id`
-- is NOT NULL and means "the one workspace wallet this bought for") so the
-- existing purchases table and its webhook path are never touched by the pool
-- model. `applies_to_workspace_id` null means "all my workspaces" at the time
-- of purchase; a value pins the funding choice made at checkout.
create table if not exists public.comms_pool_credit_purchases (
  id uuid primary key,
  funder_user_id uuid not null references public.profiles(id) on delete cascade,
  applies_to_workspace_id uuid references public.portal_workspaces(id) on delete set null,
  credit_cents integer not null check (credit_cents >= 500 and credit_cents <= 50000 and credit_cents % 100 = 0),
  stripe_session_id text unique,
  stripe_payment_intent_id text unique,
  status text not null default 'pending' check (status in ('pending','paid','reversed')),
  reversed_cents integer not null default 0 check (reversed_cents >= 0),
  receipt_url text,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  unique (funder_user_id, id)
);
create table if not exists public.comms_pool_credit_adjustments (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid not null references public.comms_pool_credit_purchases(id) on delete cascade,
  funder_user_id uuid not null references public.profiles(id) on delete cascade,
  provider_event_id text not null unique,
  amount_cents integer not null,
  reason text not null,
  created_at timestamptz not null default now()
);
create index if not exists comms_pool_credit_purchases_funder_created
  on public.comms_pool_credit_purchases(funder_user_id, created_at desc);
alter table public.comms_pool_credit_purchases enable row level security;
alter table public.comms_pool_credit_adjustments enable row level security;
revoke all on public.comms_pool_credit_purchases, public.comms_pool_credit_adjustments from anon, authenticated;
grant all on public.comms_pool_credit_purchases, public.comms_pool_credit_adjustments to service_role;

-- Migrate existing purchased balances into the new pool additively: every
-- owner's PURCHASED credit across all of their old per-workspace wallets is
-- summed into their new account pool once. Included credit is deliberately
-- NOT copied — it is recomputed fresh (from `comms_plan_credit_rules`) the
-- first time the pool is applied for that owner, exactly as the comment on
-- `comms_account_pools` promises. ON CONFLICT DO NOTHING makes this
-- one-time and safe to leave in a re-run: a pool row already present (because
-- it has since been spent from) is never overwritten with a stale sum.
insert into public.comms_account_pools(funder_user_id, purchased_credit_cents)
select manager_user_id, greatest(0, sum(purchased_credit_cents))
from public.manager_comms_workspace_wallets
group by manager_user_id
on conflict (funder_user_id) do nothing;

-- Read-only when p_apply=false. `p_tier` is resolved by the caller
-- (`getEffectiveManagerSkuTier`, Stripe-backed) and looked up here only
-- against `comms_plan_credit_rules` for the admin-configured included
-- allowance, shared-across-workspaces and rolls-over flags.
create or replace function public.comms_pool_snapshot(
  p_funder uuid, p_tier text, p_apply boolean default false
) returns jsonb language plpgsql security definer set search_path = public, pg_temp set timezone = 'UTC' as $$
declare
  pool public.comms_account_pools%rowtype;
  rule public.comms_plan_credit_rules%rowtype;
  acct public.manager_comms_billing_accounts%rowtype;
  period_start timestamptz := date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
  allowance integer;
  remaining integer;
  rollover_amount integer := 0;
begin
  if p_funder is null or p_tier is null then raise exception 'Invalid communication pool request'; end if;
  select * into rule from public.comms_plan_credit_rules where tier = p_tier;
  if not found then raise exception 'Unknown communication plan tier'; end if;

  if p_apply then
    insert into public.manager_comms_billing_accounts(manager_user_id) values (p_funder) on conflict do nothing;
    select * into strict acct from public.manager_comms_billing_accounts where manager_user_id = p_funder for update;
    insert into public.comms_account_pools(funder_user_id) values (p_funder) on conflict do nothing;
    select * into strict pool from public.comms_account_pools where funder_user_id = p_funder for update;
  else
    select * into acct from public.manager_comms_billing_accounts where manager_user_id = p_funder;
    select * into pool from public.comms_account_pools where funder_user_id = p_funder;
  end if;

  if pool.credit_period_start is null or pool.credit_period_start <> period_start then
    -- A rollover plan never lets unused included credit expire: fold last
    -- period's leftover into purchased credit (which already never expires)
    -- before granting the fresh period's allowance. A non-rollover plan drops
    -- it, exactly like today's per-workspace wallet.
    if pool.credit_period_start is not null and rule.rolls_over then
      rollover_amount := greatest(0, coalesce(pool.included_remaining_cents, 0));
    end if;
    allowance := rule.included_cents;
    remaining := rule.included_cents;
  else
    -- Same period: an admin raising the plan's included credit mid-period
    -- adds only the positive difference, mirroring `comms_wallet_snapshot`.
    allowance := greatest(pool.included_allowance_cents, rule.included_cents);
    remaining := pool.included_remaining_cents + greatest(0, rule.included_cents - pool.included_allowance_cents);
  end if;

  if p_apply then
    update public.comms_account_pools set
      credit_period_start = period_start,
      included_allowance_cents = allowance,
      included_remaining_cents = remaining,
      purchased_credit_cents = purchased_credit_cents + rollover_amount,
      credit_cutover_at = coalesce(credit_cutover_at, now()),
      updated_at = now()
      where funder_user_id = p_funder
      returning * into pool;
  end if;

  return jsonb_build_object(
    'allowance_cents', allowance,
    'included_remaining_cents', remaining,
    'purchased_remaining_cents', greatest(0, coalesce(pool.purchased_credit_cents, 0) + case when p_apply then 0 else rollover_amount end),
    'period_start', period_start,
    'period_end', period_start + interval '1 month',
    'paused', acct.billing_paused_at is not null,
    'shared_across_workspaces', rule.shared_across_workspaces,
    'rolls_over', rule.rolls_over,
    'funder_user_id', p_funder
  );
end $$;

-- Reserve credit for one workspace from its ordered list of funders
-- (`p_funders`: a JSON array of `{"funder": uuid, "tier": text}`, owner
-- first — the TypeScript caller resolves that order and each funder's live
-- plan tier). The FIRST eligible funder who can cover the FULL cost pays it
-- (included credit, then purchased); this function never splits one
-- reservation's cost across several funders. A funder is skipped when: they
-- do not fund this workspace, their plan is not shared across workspaces and
-- this is not their own default workspace, their monthly limit for this
-- workspace would be exceeded, their billing is paused, or they cannot cover
-- the full cost. `p_manager_context` is the account whose conversation this
-- is (unchanged reporting identity — usage rows keep grouping by it exactly
-- as before); `funder_user_id` on the event is the separate, new "who
-- actually paid" identity a refund reads back.
create or replace function public.reserve_comms_credit_pool(
  p_manager_context uuid,
  p_workspace uuid,
  p_funders jsonb,
  p_key text,
  p_meter text,
  p_quantity numeric,
  p_unit_cents integer,
  p_metadata jsonb default '{}'::jsonb,
  p_allow_unfunded boolean default false
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  cost integer;
  e public.manager_comms_usage_events%rowtype;
  f record;
  funding public.comms_workspace_funding%rowtype;
  snap jsonb;
  pool public.comms_account_pools%rowtype;
  existing_spend integer;
  chosen uuid;
  chosen_period timestamptz;
  chosen_included integer;
  chosen_purchased integer;
  owner_id uuid;
  owner_tier text;
begin
  if p_manager_context is null or p_workspace is null or p_key is null or length(p_key) < 1 or length(p_key) > 300
    or p_quantity is null or p_quantity <= 0 or p_quantity > 1000000
    or p_unit_cents is null or p_unit_cents < 0 or p_unit_cents > 1000000 then
    raise exception 'Invalid communication reservation';
  end if;
  cost := round(p_quantity * p_unit_cents)::integer;

  select * into e from public.manager_comms_usage_events where idempotency_key = p_key;
  if found then
    if e.manager_user_id <> p_manager_context or e.meter <> p_meter or e.unit_price_cents <> p_unit_cents or e.quantity <> p_quantity then
      raise exception 'Communication reservation identity mismatch';
    end if;
    return jsonb_build_object('allowed', e.credit_state in ('reserved','settled'), 'duplicate', true, 'state', e.credit_state, 'funder', e.funder_user_id);
  end if;

  for f in select value ->> 'funder' as funder, value ->> 'tier' as tier
           from jsonb_array_elements(coalesce(p_funders, '[]'::jsonb)) value
  loop
    continue when f.funder is null or f.tier is null;

    select * into funding from public.comms_workspace_funding
      where funder_user_id = f.funder::uuid and workspace_id = p_workspace and enabled for update;
    if not found then continue; end if;

    snap := public.comms_pool_snapshot(f.funder::uuid, f.tier, true);
    if snap is null then continue; end if;
    if coalesce((snap ->> 'paused')::boolean, false) and not p_allow_unfunded then continue; end if;
    if not coalesce((snap ->> 'shared_across_workspaces')::boolean, false) and not p_allow_unfunded then
      if not exists (select 1 from public.portal_workspaces where id = p_workspace and owner_user_id = f.funder::uuid and is_default) then
        continue;
      end if;
    end if;

    select * into pool from public.comms_account_pools where funder_user_id = f.funder::uuid for update;

    select coalesce(spent_cents, 0) into existing_spend from public.comms_funder_workspace_spend
      where funder_user_id = f.funder::uuid and workspace_id = p_workspace and period_start = pool.credit_period_start;
    if not p_allow_unfunded and funding.monthly_limit_cents is not null
      and coalesce(existing_spend, 0) + cost > funding.monthly_limit_cents then
      continue;
    end if;

    if not p_allow_unfunded and cost > pool.included_remaining_cents + greatest(0, pool.purchased_credit_cents) then
      continue;
    end if;

    chosen := f.funder::uuid;
    chosen_period := pool.credit_period_start;
    chosen_included := least(cost, greatest(0, pool.included_remaining_cents));
    chosen_purchased := least(cost - chosen_included, greatest(0, pool.purchased_credit_cents));
    exit;
  end loop;

  if chosen is null and p_allow_unfunded then
    -- Last resort for unavoidable inbound-style usage (inbound SMS, voice
    -- minutes already spent): the workspace owner's pool always accepts it,
    -- even past their own limit or funding toggle, so an unavoidable cost is
    -- never dropped for a billing reason — the same guarantee the legacy
    -- per-workspace wallet gives via its own `p_allow_unfunded`.
    select owner_user_id into owner_id from public.portal_workspaces where id = p_workspace;
    if owner_id is not null then
      select value ->> 'tier' into owner_tier from jsonb_array_elements(coalesce(p_funders, '[]'::jsonb)) value
        where value ->> 'funder' = owner_id::text limit 1;
      snap := public.comms_pool_snapshot(owner_id, coalesce(owner_tier, 'free'), true);
      select * into pool from public.comms_account_pools where funder_user_id = owner_id for update;
      chosen := owner_id;
      chosen_period := pool.credit_period_start;
      chosen_included := least(cost, greatest(0, pool.included_remaining_cents));
      chosen_purchased := cost - chosen_included;
    end if;
  end if;

  if chosen is null then
    return jsonb_build_object('allowed', false, 'reason', 'allowance_exhausted');
  end if;

  insert into public.manager_comms_usage_events(manager_user_id, workspace_id, meter, quantity, unit_price_cents, total_cents,
      idempotency_key, metadata, credit_state, included_debit_cents, purchased_debit_cents, platform_absorbed_cents,
      credit_period_start, funder_user_id)
    values (p_manager_context, p_workspace, p_meter, p_quantity, p_unit_cents, cost, p_key, p_metadata,
      case when p_allow_unfunded then 'settled' else 'reserved' end,
      chosen_included, chosen_purchased, greatest(0, cost - chosen_included - chosen_purchased), chosen_period, chosen);

  update public.comms_account_pools set
    included_remaining_cents = included_remaining_cents - chosen_included,
    purchased_credit_cents = purchased_credit_cents - chosen_purchased,
    updated_at = now()
    where funder_user_id = chosen;

  insert into public.comms_funder_workspace_spend(funder_user_id, workspace_id, period_start, spent_cents)
    values (chosen, p_workspace, chosen_period, cost)
    on conflict (funder_user_id, workspace_id, period_start)
    do update set spent_cents = comms_funder_workspace_spend.spent_cents + excluded.spent_cents, updated_at = now();

  return jsonb_build_object('allowed', true, 'duplicate', false,
    'state', case when p_allow_unfunded then 'settled' else 'reserved' end, 'funder', chosen);
end $$;

-- Release or settle a pool reservation. Reads the paying funder and workspace
-- off the event itself — never a caller-supplied identity — so a refund
-- always lands in the exact pool that was debited.
create or replace function public.finish_comms_credit_pool(p_manager_context uuid, p_key text, p_release boolean default false)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.manager_comms_usage_events%rowtype; funder uuid; ws uuid;
begin
  select funder_user_id, workspace_id into funder, ws from public.manager_comms_usage_events
    where manager_user_id = p_manager_context and idempotency_key = p_key;
  if funder is null then return false; end if;
  perform 1 from public.manager_comms_billing_accounts where manager_user_id = funder for update;
  perform 1 from public.comms_account_pools where funder_user_id = funder for update;
  perform 1 from public.comms_funder_workspace_spend where funder_user_id = funder and workspace_id = ws for update;
  select * into e from public.manager_comms_usage_events
    where manager_user_id = p_manager_context and idempotency_key = p_key for update;
  if not found then return false; end if;
  if e.credit_state <> 'reserved' then return e.credit_state = 'settled' or (p_release and e.credit_state = 'released'); end if;
  if p_release then
    update public.comms_account_pools set
      included_remaining_cents = included_remaining_cents + case when credit_period_start = e.credit_period_start then e.included_debit_cents else 0 end,
      purchased_credit_cents = purchased_credit_cents + e.purchased_debit_cents,
      updated_at = now()
      where funder_user_id = funder;
    update public.comms_funder_workspace_spend set spent_cents = greatest(0, spent_cents - e.total_cents), updated_at = now()
      where funder_user_id = funder and workspace_id = ws and period_start = e.credit_period_start;
  end if;
  update public.manager_comms_usage_events set credit_state = case when p_release then 'released' else 'settled' end
    where id = e.id;
  return true;
end $$;

-- Settle a bounded call against provider-reported duration, refunding unused
-- credit to the same funder pool the reservation debited.
create or replace function public.settle_comms_credit_quantity_pool(p_manager_context uuid, p_key text, p_quantity numeric)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  e public.manager_comms_usage_events%rowtype; funder uuid; ws uuid;
  cost integer; refund integer; purchased_refund integer;
begin
  if p_quantity is null or p_quantity < 0 then raise exception 'Invalid settlement quantity'; end if;
  select funder_user_id, workspace_id into funder, ws from public.manager_comms_usage_events
    where manager_user_id = p_manager_context and idempotency_key = p_key;
  if funder is null then return false; end if;
  perform 1 from public.manager_comms_billing_accounts where manager_user_id = funder for update;
  perform 1 from public.comms_account_pools where funder_user_id = funder for update;
  perform 1 from public.comms_funder_workspace_spend where funder_user_id = funder and workspace_id = ws for update;
  select * into e from public.manager_comms_usage_events
    where manager_user_id = p_manager_context and idempotency_key = p_key for update;
  if not found then return false; end if;
  if e.credit_state = 'settled' or e.credit_state = 'released' then return true; end if;
  if e.credit_state <> 'reserved' then return false; end if;
  cost := least(e.total_cents, round(p_quantity * e.unit_price_cents)::integer);
  refund := e.total_cents - cost;
  purchased_refund := least(refund, e.purchased_debit_cents);
  update public.comms_account_pools set
    purchased_credit_cents = purchased_credit_cents + purchased_refund,
    included_remaining_cents = included_remaining_cents + case when credit_period_start = e.credit_period_start then refund - purchased_refund else 0 end,
    updated_at = now() where funder_user_id = funder;
  update public.comms_funder_workspace_spend set spent_cents = greatest(0, spent_cents - refund), updated_at = now()
    where funder_user_id = funder and workspace_id = ws and period_start = e.credit_period_start;
  update public.manager_comms_usage_events set quantity = p_quantity, total_cents = round(p_quantity * e.unit_price_cents)::integer,
    platform_absorbed_cents = greatest(0, round(p_quantity * e.unit_price_cents)::integer - cost),
    purchased_debit_cents = purchased_debit_cents - purchased_refund,
    included_debit_cents = included_debit_cents - (refund - purchased_refund),
    credit_state = case when p_quantity = 0 then 'released' else 'settled' end where id = e.id;
  return true;
end $$;

create or replace function public.fulfill_comms_pool_credit_purchase(
  p_purchase uuid, p_funder uuid, p_session text, p_payment_intent text, p_credit integer, p_event text, p_receipt text default null
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare purchase public.comms_pool_credit_purchases%rowtype;
begin
  insert into public.manager_comms_billing_accounts(manager_user_id) values (p_funder) on conflict do nothing;
  perform 1 from public.manager_comms_billing_accounts where manager_user_id = p_funder for update;
  insert into public.comms_account_pools(funder_user_id) values (p_funder) on conflict do nothing;
  perform 1 from public.comms_account_pools where funder_user_id = p_funder for update;
  select * into strict purchase from public.comms_pool_credit_purchases where id = p_purchase and funder_user_id = p_funder for update;
  if purchase.credit_cents <> p_credit or (purchase.stripe_session_id is not null and purchase.stripe_session_id <> p_session)
    or (purchase.stripe_payment_intent_id is not null and purchase.stripe_payment_intent_id <> p_payment_intent)
    or p_session is null or p_payment_intent is null or p_event is null then raise exception 'Credit purchase mismatch'; end if;
  if purchase.status <> 'pending' then return false; end if;
  update public.comms_pool_credit_purchases set status = 'paid', stripe_session_id = p_session,
    stripe_payment_intent_id = p_payment_intent, paid_at = now(), receipt_url = p_receipt where id = p_purchase;
  insert into public.comms_pool_credit_adjustments(purchase_id, funder_user_id, provider_event_id, amount_cents, reason)
    values (p_purchase, p_funder, p_event, p_credit, 'purchase');
  update public.comms_account_pools set purchased_credit_cents = purchased_credit_cents + p_credit, updated_at = now()
    where funder_user_id = p_funder;
  return true;
end $$;

create or replace function public.reverse_comms_pool_credit_purchase(p_payment_intent text, p_reversed integer, p_event text, p_reason text)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare purchase public.comms_pool_credit_purchases%rowtype; delta integer; remaining integer;
begin
  select * into purchase from public.comms_pool_credit_purchases where stripe_payment_intent_id = p_payment_intent;
  if not found then return false; end if;
  perform 1 from public.manager_comms_billing_accounts where manager_user_id = purchase.funder_user_id for update;
  perform 1 from public.comms_account_pools where funder_user_id = purchase.funder_user_id for update;
  select * into strict purchase from public.comms_pool_credit_purchases where id = purchase.id for update;
  delta := greatest(0, least(purchase.credit_cents, p_reversed) - purchase.reversed_cents);
  if delta = 0 then return false; end if;
  insert into public.comms_pool_credit_adjustments(purchase_id, funder_user_id, provider_event_id, amount_cents, reason)
    values (purchase.id, purchase.funder_user_id, p_event, -delta, p_reason) on conflict (provider_event_id) do nothing;
  if not found then return false; end if;
  update public.comms_pool_credit_purchases set reversed_cents = reversed_cents + delta,
    status = case when reversed_cents + delta = credit_cents then 'reversed' else status end where id = purchase.id;
  update public.comms_account_pools set purchased_credit_cents = purchased_credit_cents - delta, updated_at = now()
    where funder_user_id = purchase.funder_user_id
    returning purchased_credit_cents into remaining;
  update public.manager_comms_billing_accounts set
    billing_paused_at = case when coalesce(remaining, 0) < 0 or p_reason = 'dispute' then coalesce(billing_paused_at, now()) else billing_paused_at end,
    billing_pause_reason = case when coalesce(remaining, 0) < 0 or p_reason = 'dispute' then 'credit_reversal_review' else billing_pause_reason end,
    updated_at = now() where manager_user_id = purchase.funder_user_id;
  return true;
end $$;

revoke all on function public.comms_pool_snapshot(uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.reserve_comms_credit_pool(uuid, uuid, jsonb, text, text, numeric, integer, jsonb, boolean) from public, anon, authenticated;
revoke all on function public.finish_comms_credit_pool(uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.settle_comms_credit_quantity_pool(uuid, text, numeric) from public, anon, authenticated;
revoke all on function public.fulfill_comms_pool_credit_purchase(uuid, uuid, text, text, integer, text, text) from public, anon, authenticated;
revoke all on function public.reverse_comms_pool_credit_purchase(text, integer, text, text) from public, anon, authenticated;
grant execute on function public.comms_pool_snapshot(uuid, text, boolean) to service_role;
grant execute on function public.reserve_comms_credit_pool(uuid, uuid, jsonb, text, text, numeric, integer, jsonb, boolean) to service_role;
grant execute on function public.finish_comms_credit_pool(uuid, text, boolean) to service_role;
grant execute on function public.settle_comms_credit_quantity_pool(uuid, text, numeric) to service_role;
grant execute on function public.fulfill_comms_pool_credit_purchase(uuid, uuid, text, text, integer, text, text) to service_role;
grant execute on function public.reverse_comms_pool_credit_purchase(text, integer, text, text) to service_role;
