-- A resident's whole Checkout cart is claimed before Stripe is called. The
-- charge slots serialize overlapping carts and the stored provider request is
-- immutable while the outcome could still settle. All entrypoints are service
-- role only; the caller derives the resident from an authenticated session.
create table if not exists public.resident_checkout_attempts (
  id uuid primary key default gen_random_uuid(),
  attempt_token uuid not null unique default gen_random_uuid(),
  resident_user_id uuid references auth.users(id) on delete set null,
  resident_email text not null,
  manager_user_id uuid not null references auth.users(id) on delete cascade,
  charge_ids text[] not null,
  charge_cents integer[] not null,
  subtotal_cents integer not null check (subtotal_cents > 0),
  payer_total_cents integer not null check (payer_total_cents >= subtotal_cents),
  recipient_net_cents integer not null check (recipient_net_cents > 0),
  payment_method text not null check (payment_method in ('ach','card')),
  currency text not null default 'usd' check (currency = 'usd'),
  provider_params jsonb not null,
  stripe_session_id text unique,
  stripe_payment_intent_id text,
  status text not null default 'pending' check (status in ('pending','processing','settled','expired','failed')),
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (cardinality(charge_ids) between 1 and 10),
  check (cardinality(charge_ids) = cardinality(charge_cents))
);

create index if not exists resident_checkout_attempts_resident_idx
  on public.resident_checkout_attempts(resident_user_id, created_at desc);
create index if not exists resident_checkout_attempts_manager_idx
  on public.resident_checkout_attempts(manager_user_id, created_at desc);

-- One active payment source per charge, shared with off-session autopay.
-- Settled slots remain for replay; only a proved terminal failure/expiry is
-- released, and then only if its token still owns the slot.
create table if not exists public.resident_charge_payment_slots (
  charge_id text primary key references public.portal_household_charge_records(id) on delete cascade,
  checkout_attempt_id uuid references public.resident_checkout_attempts(id) on delete cascade,
  autopay_run_id uuid references public.resident_autopay_runs(id) on delete cascade,
  created_at timestamptz not null default now(),
  check ((checkout_attempt_id is not null) <> (autopay_run_id is not null))
);
create index if not exists resident_charge_payment_slots_checkout_idx
  on public.resident_charge_payment_slots(checkout_attempt_id);
create index if not exists resident_charge_payment_slots_autopay_idx
  on public.resident_charge_payment_slots(autopay_run_id);

alter table public.resident_checkout_attempts enable row level security;
alter table public.resident_charge_payment_slots enable row level security;
revoke all on public.resident_checkout_attempts from public, anon, authenticated;
revoke all on public.resident_charge_payment_slots from public, anon, authenticated;
grant all on public.resident_checkout_attempts to service_role;
grant all on public.resident_charge_payment_slots to service_role;

-- A still-running autopay caller writes its claimed run before creating a PI.
-- Make that legacy insert (and failed -> claimed retry) observe the same
-- charge-row serialization as a new whole-cart claim. A foreign Checkout or
-- autopay slot wins before the old caller can reach Stripe; an exact same-run
-- slot remains valid for its existing PI/replay and is checked again by the
-- current reserve RPC.
create or replace function public.resident_autopay_claim_respects_charge_slot()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_slot public.resident_charge_payment_slots%rowtype;
begin
  if new.status<>'claimed' then return new; end if;
  if tg_op='UPDATE' and old.status='claimed' then return new; end if;
  perform 1 from public.portal_household_charge_records where id=new.charge_id for update;
  if not found then raise exception 'Autopay charge is missing'; end if;
  select * into v_slot from public.resident_charge_payment_slots
    where charge_id=new.charge_id;
  if found and (v_slot.checkout_attempt_id is not null or
      v_slot.autopay_run_id is distinct from new.id) then
    raise exception 'Another payment owns this charge';
  end if;
  return new;
end;
$$;
drop trigger if exists resident_autopay_claim_respects_charge_slot on public.resident_autopay_runs;
create trigger resident_autopay_claim_respects_charge_slot
  before insert or update of status on public.resident_autopay_runs
  for each row execute function public.resident_autopay_claim_respects_charge_slot();
revoke all on function public.resident_autopay_claim_respects_charge_slot() from public,anon,authenticated;
grant execute on function public.resident_autopay_claim_respects_charge_slot() to service_role;

-- The financial-history guard migration predates this table. A resident
-- deletion pseudonymizes the attempt but keeps its immutable source; stale
-- service-role replay must not reattach the deleted email or user id.
do $$ begin
  if not exists (select 1 from pg_trigger where
    tgrelid = 'public.resident_checkout_attempts'::regclass and
    tgname = 'account_guard_deleted_financial_identity') then
    create trigger account_guard_deleted_financial_identity
      before insert or update on public.resident_checkout_attempts
      for each row execute function public.account_guard_deleted_financial_identity();
  end if;
end $$;

-- Both the TS quote and the SQL claim must agree with the stored charge's
-- balance. A malformed amount is unresolved, never a new amount authority.
create or replace function public.resident_claim_charge_cents(p_row jsonb)
returns integer language plpgsql immutable set search_path = public, pg_temp as $$
declare v_label text; v_cents numeric;
begin
  v_label := coalesce(nullif(trim(p_row->>'balanceLabel'), ''), nullif(trim(p_row->>'amountLabel'), ''));
  if v_label is null or v_label !~ '^\$?[0-9][0-9,]*(\.[0-9]{1,2})?$' then return null; end if;
  v_cents := replace(replace(v_label, '$', ''), ',', '')::numeric * 100;
  if v_cents <> trunc(v_cents) or v_cents < 100 or v_cents > 500000 then return null; end if;
  return v_cents::integer;
exception when others then return null;
end;
$$;

create or replace function public.resident_checkout_attempt_immutable_terms()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if old.attempt_token is distinct from new.attempt_token or
     old.manager_user_id is distinct from new.manager_user_id or
     old.charge_ids is distinct from new.charge_ids or
     old.charge_cents is distinct from new.charge_cents or
     old.subtotal_cents is distinct from new.subtotal_cents or
     old.payer_total_cents is distinct from new.payer_total_cents or
     old.recipient_net_cents is distinct from new.recipient_net_cents or
     old.payment_method is distinct from new.payment_method or
     old.currency is distinct from new.currency or
     old.provider_params is distinct from new.provider_params or
     old.created_at is distinct from new.created_at then
    raise exception 'Resident checkout provider terms are immutable';
  end if;
  return new;
end;
$$;
do $$ begin
  if not exists (select 1 from pg_trigger where
    tgrelid = 'public.resident_checkout_attempts'::regclass and
    tgname = 'resident_checkout_attempt_immutable_terms') then
    create trigger resident_checkout_attempt_immutable_terms
      before update on public.resident_checkout_attempts
      for each row execute function public.resident_checkout_attempt_immutable_terms();
  end if;
end $$;

-- Resident purge gives the attempt and each charge different pseudonyms.
-- A delayed provider settlement may still use their immutable source only
-- when the two retained tombstones prove the same deleted email. A new login
-- at that address receives a new auth id and can never verify the old claim.
create or replace function public.resident_checkout_payer_matches(
  p_attempt_id uuid, p_charge_id text, p_original_email text,
  p_attempt_user uuid, p_attempt_email text, p_charge_user uuid, p_charge_email text
) returns boolean language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_hash text;
begin
  if p_attempt_user is not null then
    return coalesce((p_charge_user is null or p_charge_user = p_attempt_user) and
      lower(p_charge_email) = lower(p_attempt_email) and
      lower(p_original_email) = lower(p_attempt_email), false);
  end if;
  if p_charge_user is not null or
     p_attempt_email not like 'deleted-%@deleted.invalid' or
     p_charge_email not like 'deleted-%@deleted.invalid' then return false; end if;
  v_hash := public.account_identity_hash(p_original_email);
  return exists(select 1 from public.account_deleted_record_identities a
    join public.account_deleted_record_identities c on
      c.table_name = 'portal_household_charge_records' and c.record_id = p_charge_id
    where a.table_name = 'resident_checkout_attempts' and a.record_id = p_attempt_id::text
      and v_hash = any(a.identity_hashes) and v_hash = any(c.identity_hashes));
end;
$$;

create or replace function public.reserve_resident_checkout_attempt(
  p_attempt_token uuid, p_resident_user_id uuid, p_resident_email text, p_manager_user_id uuid,
  p_charge_ids text[], p_charge_cents integer[], p_subtotal_cents integer,
  p_payer_total_cents integer, p_recipient_net_cents integer,
  p_payment_method text, p_provider_params jsonb
) returns public.resident_checkout_attempts language plpgsql security definer
  set search_path = public, pg_temp as $$
declare
  v_charge public.portal_household_charge_records%rowtype;
  v_id text;
  v_index integer := 0;
  v_owner uuid;
  v_slot public.resident_charge_payment_slots%rowtype;
  v_existing_id uuid;
  v_attempt public.resident_checkout_attempts%rowtype;
begin
  if p_attempt_token is null or p_resident_user_id is null or p_manager_user_id is null or
     nullif(trim(p_resident_email), '') is null or
     cardinality(p_charge_ids) not between 1 and 10 or
     cardinality(p_charge_ids) <> cardinality(p_charge_cents) or
     p_charge_ids is distinct from (select array_agg(id order by id) from unnest(p_charge_ids) id) or
     (select count(distinct id) from unnest(p_charge_ids) id) <> cardinality(p_charge_ids) or
     (select sum(cents) from unnest(p_charge_cents) cents) is distinct from p_subtotal_cents or
     p_subtotal_cents < 100 or p_payer_total_cents < p_subtotal_cents or
     p_recipient_net_cents <= 0 or p_recipient_net_cents > p_payer_total_cents or
     p_payment_method not in ('ach','card') or
     jsonb_typeof(p_provider_params) is distinct from 'object' or
     p_provider_params->>'paymentMethod' is distinct from p_payment_method or
     p_provider_params->>'residentEmail' is distinct from lower(trim(p_resident_email)) or
     p_provider_params->'metadata'->>'resident_attempt_token' is distinct from p_attempt_token::text then
    raise exception 'Invalid resident checkout quote';
  end if;

  -- Lock every charge in sorted order. A conflicting [A,B] and [B,C] must
  -- finish as one whole-cart winner, never partial slots for the loser.
  for v_id in select id from unnest(p_charge_ids) id order by id loop
    select * into v_charge from public.portal_household_charge_records
      where id = v_id for update;
    v_index := v_index + 1;
    if not found or v_charge.status not in ('pending','failed','processing') or
       v_charge.row_data->>'id' is distinct from v_id or
       v_charge.row_data->>'status' not in ('pending','failed','processing') or
       v_charge.row_data->>'managerUserId' is distinct from v_charge.manager_user_id::text or
       coalesce(v_charge.row_data->>'propertyId','') is distinct from coalesce(v_charge.property_id, '') or
       lower(v_charge.row_data->>'residentEmail') is distinct from lower(v_charge.resident_email) or
       (case when v_charge.resident_user_id is not null
         then v_charge.resident_user_id is distinct from p_resident_user_id
         else lower(v_charge.resident_email) is distinct from lower(trim(p_resident_email)) end) or
       public.resident_claim_charge_cents(v_charge.row_data) is distinct from p_charge_cents[v_index] then
      raise exception 'Resident charge changed before checkout';
    end if;
    if nullif(trim(v_charge.property_id), '') is not null then
      select manager_user_id into v_owner from public.manager_property_records
        where id = v_charge.property_id for share;
      if not found or v_owner is null or v_owner is distinct from p_manager_user_id or
         v_charge.manager_user_id is distinct from v_owner then
        raise exception 'Resident charge owner needs payment review';
      end if;
    elsif v_charge.manager_user_id is distinct from p_manager_user_id then
      raise exception 'Propertyless charge manager changed before checkout';
    end if;
    if exists (select 1 from public.resident_autopay_runs r where r.charge_id = v_id
      and r.status in ('claimed','succeeded')) then
      raise exception 'Autopay already owns this charge';
    end if;
    select * into v_slot from public.resident_charge_payment_slots
      where charge_id = v_id for update;
    -- A pre-migration Checkout may have written its source reference without
    -- owning a new slot. Never mint a second source over that reference.
    if not found and nullif(trim(v_charge.row_data->>'stripeCheckoutSessionId'), '') is not null then
      raise exception 'Existing checkout source needs payment review';
    end if;
    if v_charge.status = 'processing' and
       (not found or v_slot.checkout_attempt_id is null or
        v_charge.row_data->>'stripeCheckoutSessionId' is null) then
      raise exception 'Processing charge has no matching checkout attempt';
    end if;
    if found then
      if v_slot.checkout_attempt_id is null then raise exception 'Another payment owns this charge'; end if;
      if v_existing_id is null then v_existing_id := v_slot.checkout_attempt_id;
      elsif v_existing_id is distinct from v_slot.checkout_attempt_id then
        raise exception 'Selected charges belong to different payment attempts';
      end if;
    elsif v_existing_id is not null then
      raise exception 'Selected charges overlap an existing payment';
    end if;
  end loop;

  if v_existing_id is not null then
    select * into v_attempt from public.resident_checkout_attempts where id = v_existing_id for update;
    if not found or v_attempt.status not in ('pending','processing') or
       v_attempt.resident_user_id is distinct from p_resident_user_id or
       v_attempt.manager_user_id is distinct from p_manager_user_id or
       v_attempt.resident_email is distinct from lower(trim(p_resident_email)) or
       v_attempt.charge_ids is distinct from p_charge_ids or
       v_attempt.charge_cents is distinct from p_charge_cents or
       v_attempt.subtotal_cents is distinct from p_subtotal_cents or
       v_attempt.payment_method is distinct from p_payment_method or
       (select count(*) from public.resident_charge_payment_slots
        where checkout_attempt_id = v_existing_id) <> cardinality(p_charge_ids) then
      raise exception 'A different payment attempt owns this cart';
    end if;
    return v_attempt;
  end if;

  insert into public.resident_checkout_attempts (
    attempt_token, resident_user_id, resident_email, manager_user_id, charge_ids, charge_cents,
    subtotal_cents, payer_total_cents, recipient_net_cents, payment_method, provider_params
  ) values (
    p_attempt_token, p_resident_user_id, lower(trim(p_resident_email)), p_manager_user_id,
    p_charge_ids, p_charge_cents, p_subtotal_cents, p_payer_total_cents,
    p_recipient_net_cents, p_payment_method, p_provider_params
  ) returning * into v_attempt;
  for v_id in select id from unnest(p_charge_ids) id order by id loop
    insert into public.resident_charge_payment_slots(charge_id, checkout_attempt_id)
      values(v_id, v_attempt.id);
  end loop;
  return v_attempt;
end;
$$;

create or replace function public.mark_resident_checkout_processing(
  p_attempt_id uuid, p_attempt_token uuid, p_session_id text
) returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_attempt public.resident_checkout_attempts%rowtype;
  v_charge public.portal_household_charge_records%rowtype;
  v_id text;
  v_marked integer := 0;
begin
  select * into v_attempt from public.resident_checkout_attempts where id = p_attempt_id;
  if not found then return 0; end if;
  for v_id in select id from unnest(v_attempt.charge_ids) id order by id loop
    perform 1 from public.portal_household_charge_records where id = v_id for update;
  end loop;
  select * into v_attempt from public.resident_checkout_attempts where id = p_attempt_id for update;
  if v_attempt.attempt_token is distinct from p_attempt_token or
     v_attempt.stripe_session_id is distinct from p_session_id or
     (v_attempt.provider_params->'metadata'->>'resident_payment_flow' = 'manual_ach' and
      left(p_session_id,3) <> 'pi_') or
     (coalesce(v_attempt.provider_params->'metadata'->>'resident_payment_flow','') <> 'manual_ach' and
      left(p_session_id,3) <> 'cs_') or
     v_attempt.status not in ('pending','processing') or
     (select count(*) from public.resident_charge_payment_slots
       where checkout_attempt_id = p_attempt_id) <> cardinality(v_attempt.charge_ids) then
    raise exception 'Processing session does not own this cart';
  end if;
  for v_id in select id from unnest(v_attempt.charge_ids) id order by id loop
    select * into v_charge from public.portal_household_charge_records where id = v_id;
    if v_charge.status not in ('pending','failed','processing') or
       (v_charge.status = 'processing' and
        v_charge.row_data->>'stripeCheckoutSessionId' is distinct from p_session_id) or
       v_charge.manager_user_id is distinct from v_attempt.manager_user_id or
       not public.resident_checkout_payer_matches(v_attempt.id,v_id,
         v_attempt.provider_params->>'residentEmail',v_attempt.resident_user_id,
         v_attempt.resident_email,v_charge.resident_user_id,v_charge.resident_email) then
      raise exception 'A charge changed while the cart was processing';
    end if;
  end loop;
  for v_id in select id from unnest(v_attempt.charge_ids) id order by id loop
    update public.portal_household_charge_records set status = 'processing',
      row_data = row_data || jsonb_build_object(
        'status','processing','stripeCheckoutSessionId',p_session_id,
        'stripePaymentStatus','unpaid','processingStartedAt',coalesce(row_data->>'processingStartedAt', now()::text)),
      updated_at = now() where id = v_id and status <> 'processing';
    if found then v_marked := v_marked + 1; end if;
  end loop;
  update public.resident_checkout_attempts set status = 'processing', updated_at = now()
    where id = p_attempt_id and status = 'pending';
  return v_marked;
end;
$$;

create or replace function public.settle_resident_checkout_attempt(
  p_attempt_id uuid, p_attempt_token uuid, p_session_id text, p_payment_intent_id text
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_attempt public.resident_checkout_attempts%rowtype;
  v_charge public.portal_household_charge_records%rowtype;
  v_id text;
  v_index integer := 0;
  v_paid_at timestamptz;
  v_result jsonb := '[]'::jsonb;
  v_next jsonb;
begin
  if nullif(trim(p_payment_intent_id), '') is null then
    raise exception 'Settled cart needs a verified payment intent';
  end if;
  select * into v_attempt from public.resident_checkout_attempts where id = p_attempt_id;
  if not found then raise exception 'Checkout attempt does not exist'; end if;
  for v_id in select id from unnest(v_attempt.charge_ids) id order by id loop
    perform 1 from public.portal_household_charge_records where id = v_id for update;
  end loop;
  select * into v_attempt from public.resident_checkout_attempts where id = p_attempt_id for update;
  if v_attempt.attempt_token is distinct from p_attempt_token or
     v_attempt.stripe_session_id is distinct from p_session_id or
     v_attempt.status not in ('pending','processing','settled') or
     (v_attempt.stripe_payment_intent_id is not null and
      v_attempt.stripe_payment_intent_id is distinct from p_payment_intent_id) or
     (select count(*) from public.resident_charge_payment_slots
       where checkout_attempt_id = p_attempt_id) <> cardinality(v_attempt.charge_ids) then
    raise exception 'Paid session does not own this cart';
  end if;
  for v_id in select id from unnest(v_attempt.charge_ids) id order by id loop
    v_index := v_index + 1;
    select * into v_charge from public.portal_household_charge_records where id = v_id;
    if v_charge.manager_user_id is distinct from v_attempt.manager_user_id or
       not public.resident_checkout_payer_matches(v_attempt.id,v_id,
         v_attempt.provider_params->>'residentEmail',v_attempt.resident_user_id,
         v_attempt.resident_email,v_charge.resident_user_id,v_charge.resident_email) or
       (v_attempt.status = 'settled' and
        (v_charge.status not in ('paid','refunded') or
         v_charge.row_data->>'stripeCheckoutSessionId' is distinct from p_session_id or
         (v_charge.row_data->>'paidAmountCents')::integer is distinct from v_attempt.charge_cents[v_index])) or
       (v_attempt.status <> 'settled' and
        (v_charge.status not in ('pending','failed','processing') or
         (v_charge.row_data->>'stripeCheckoutSessionId' is not null and
          v_charge.row_data->>'stripeCheckoutSessionId' is distinct from p_session_id) or
         public.resident_claim_charge_cents(v_charge.row_data) is distinct from v_attempt.charge_cents[v_index])) then
      raise exception 'A charge changed before cart settlement';
    end if;
  end loop;
  if v_attempt.status = 'settled' then
    for v_id in select id from unnest(v_attempt.charge_ids) id order by id loop
      select row_data into v_next from public.portal_household_charge_records where id = v_id;
      v_result := v_result || jsonb_build_array(v_next);
    end loop;
    return jsonb_build_object('rows',v_result,'newlySettled',false);
  end if;
  v_paid_at := now();
  v_index := 0;
  for v_id in select id from unnest(v_attempt.charge_ids) id order by id loop
    v_index := v_index + 1;
    select * into v_charge from public.portal_household_charge_records where id = v_id;
    v_next := v_charge.row_data || jsonb_build_object(
      'status','paid','balanceLabel','$0.00',
      'paidAt',to_char(v_paid_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'paidAmountCents',v_attempt.charge_cents[v_index],
      'stripeCheckoutSessionId',p_session_id,'stripePaymentStatus','paid');
    update public.portal_household_charge_records set status = 'paid',
      row_data = v_next, updated_at = v_paid_at where id = v_id;
    v_result := v_result || jsonb_build_array(v_next);
  end loop;
  update public.resident_checkout_attempts set status = 'settled', paid_at = v_paid_at,
    stripe_payment_intent_id = p_payment_intent_id, updated_at = v_paid_at where id = p_attempt_id;
  return jsonb_build_object('rows',v_result,'newlySettled',true);
end;
$$;

create or replace function public.bind_resident_checkout_session(
  p_attempt_id uuid, p_attempt_token uuid, p_session_id text
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if nullif(trim(p_session_id), '') is null then return false; end if;
  update public.resident_checkout_attempts set stripe_session_id = p_session_id, updated_at = now()
    where id = p_attempt_id and attempt_token = p_attempt_token and status = 'pending'
      and ((provider_params->'metadata'->>'resident_payment_flow' = 'manual_ach' and
            left(p_session_id,3) = 'pi_') or
           (coalesce(provider_params->'metadata'->>'resident_payment_flow','') <> 'manual_ach' and
            left(p_session_id,3) = 'cs_'))
      and (stripe_session_id is null or stripe_session_id = p_session_id);
  return found;
end;
$$;

-- The service caller must first retrieve the exact bound Stripe session and
-- prove it is expired/failed. An unstamped create remains held for review.
create or replace function public.retire_resident_checkout_attempt(
  p_attempt_id uuid, p_attempt_token uuid, p_session_id text, p_terminal_status text
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_attempt public.resident_checkout_attempts%rowtype;
  v_charge public.portal_household_charge_records%rowtype;
  v_id text;
begin
  if p_terminal_status not in ('expired','failed') or nullif(trim(p_session_id),'') is null then return false; end if;
  select * into v_attempt from public.resident_checkout_attempts where id = p_attempt_id;
  if not found then return false; end if;
  -- The paid/processing paths lock charges before the attempt; keep this
  -- identical order so a simultaneous terminal event cannot deadlock them.
  for v_id in select id from unnest(v_attempt.charge_ids) id order by id loop
    perform 1 from public.portal_household_charge_records where id = v_id for update;
  end loop;
  select * into v_attempt from public.resident_checkout_attempts where id = p_attempt_id for update;
  if not found or v_attempt.attempt_token is distinct from p_attempt_token or
     v_attempt.stripe_session_id is distinct from p_session_id or
     v_attempt.provider_params->'metadata'->>'resident_payment_flow' = 'manual_ach' or
     v_attempt.status not in ('pending','processing') or
     (select count(*) from public.resident_charge_payment_slots
       where checkout_attempt_id = p_attempt_id) <> cardinality(v_attempt.charge_ids) then return false; end if;
  for v_id in select id from unnest(v_attempt.charge_ids) id order by id loop
    select * into v_charge from public.portal_household_charge_records where id = v_id;
    if not found or v_charge.status not in ('pending','failed','processing') or
       (v_charge.status = 'processing' and
        v_charge.row_data->>'stripeCheckoutSessionId' is distinct from p_session_id) then
      return false;
    end if;
  end loop;
  for v_id in select id from unnest(v_attempt.charge_ids) id order by id loop
    update public.portal_household_charge_records set status = 'pending',
      row_data = row_data - 'stripeCheckoutSessionId' - 'stripePaymentStatus' - 'processingStartedAt'
        || jsonb_build_object('status','pending'), updated_at = now()
      where id = v_id and status = 'processing';
  end loop;
  update public.resident_checkout_attempts set status = p_terminal_status, updated_at = now()
    where id = p_attempt_id;
  delete from public.resident_charge_payment_slots where checkout_attempt_id = p_attempt_id;
  return true;
end;
$$;

-- An off-session autopay run must acquire the same charge slot as manual
-- Checkout before PaymentIntent confirmation. Repeated provider calls are not
-- authorized by a second reservation of the same run; the existing Stripe
-- idempotency key is used only by the one holder.
create or replace function public.reserve_resident_autopay_slot(p_run_id uuid, p_attempt integer)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_run public.resident_autopay_runs%rowtype;
  v_charge public.portal_household_charge_records%rowtype;
  v_owner uuid;
  v_email text;
begin
  select * into v_run from public.resident_autopay_runs where id = p_run_id;
  if not found then return false; end if;
  select * into v_charge from public.portal_household_charge_records
    where id = v_run.charge_id for update;
  if not found then return false; end if;
  select * into v_run from public.resident_autopay_runs where id = p_run_id for update;
  select lower(email) into v_email from auth.users where id = v_run.resident_user_id;
  if v_run.status <> 'claimed' or v_run.attempt is distinct from p_attempt or
     v_run.manager_id is null or v_email is null or
     v_charge.status not in ('pending','failed') or
     v_charge.row_data->>'status' not in ('pending','failed') or
     v_charge.manager_user_id is distinct from v_run.manager_id or
     v_charge.row_data->>'managerUserId' is distinct from v_run.manager_id::text or
     v_charge.row_data->>'id' is distinct from v_run.charge_id or
     (case when v_charge.resident_user_id is not null
       then v_charge.resident_user_id is distinct from v_run.resident_user_id
       else lower(v_charge.resident_email) is distinct from v_email end) or
     public.resident_claim_charge_cents(v_charge.row_data) is null then
    return false;
  end if;
  if nullif(trim(v_charge.property_id), '') is not null then
    select manager_user_id into v_owner from public.manager_property_records
      where id = v_charge.property_id for share;
    if not found or v_owner is null or v_owner is distinct from v_run.manager_id then return false; end if;
  end if;
  -- A prior reservation, even from this same run, may already have created a
  -- PaymentIntent whose response was lost. Do not authorize a second create.
  if exists(select 1 from public.resident_charge_payment_slots where charge_id = v_run.charge_id) then
    return false;
  end if;
  insert into public.resident_charge_payment_slots(charge_id,autopay_run_id)
    values(v_run.charge_id,p_run_id);
  return true;
end;
$$;

-- Binding a returned PaymentIntent is a compare-and-set. A lost create
-- response still leaves the slot claimed; the webhook may settle using its
-- frozen run/charge metadata without inventing another debit.
create or replace function public.bind_resident_autopay_payment_intent(
  p_run_id uuid, p_attempt integer, p_payment_intent_id text
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_run public.resident_autopay_runs%rowtype;
begin
  if nullif(trim(p_payment_intent_id),'') is null then return false; end if;
  select * into v_run from public.resident_autopay_runs where id = p_run_id;
  if not found then return false; end if;
  perform 1 from public.portal_household_charge_records where id = v_run.charge_id for update;
  select * into v_run from public.resident_autopay_runs where id = p_run_id for update;
  if not found or v_run.status <> 'claimed' or
     v_run.attempt is distinct from p_attempt or
     (v_run.stripe_payment_intent_id is not null and
      v_run.stripe_payment_intent_id is distinct from p_payment_intent_id) or
     not exists(select 1 from public.resident_charge_payment_slots
       where charge_id = v_run.charge_id and autopay_run_id = p_run_id) then return false; end if;
  update public.resident_autopay_runs set stripe_payment_intent_id = p_payment_intent_id,
    updated_at = now() where id = p_run_id;
  return true;
end;
$$;

-- The verified provider source, charge and run settle in one transaction.
-- Retaining the slot on success makes the same PI replay harmless.
create or replace function public.settle_resident_autopay_run(
  p_run_id uuid, p_attempt integer, p_payment_intent_id text, p_principal_cents integer,
  p_resident_email text
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_run public.resident_autopay_runs%rowtype;
  v_charge public.portal_household_charge_records%rowtype;
  v_owner uuid;
  v_paid_at timestamptz;
  v_next jsonb;
begin
  if nullif(trim(p_payment_intent_id),'') is null or p_principal_cents < 100 or
     nullif(trim(p_resident_email),'') is null then
    raise exception 'Invalid autopay settlement terms';
  end if;
  select * into v_run from public.resident_autopay_runs where id = p_run_id;
  if not found then raise exception 'Autopay run requires provider reconciliation'; end if;
  select * into v_charge from public.portal_household_charge_records
    where id = v_run.charge_id for update;
  if not found then raise exception 'Autopay charge requires provider reconciliation'; end if;
  select * into v_run from public.resident_autopay_runs where id = p_run_id for update;
  if not found or v_run.charge_id is distinct from v_charge.id or
     v_run.attempt is distinct from p_attempt or
     v_run.status not in ('claimed','succeeded') or
     v_run.stripe_payment_intent_id is distinct from p_payment_intent_id and
       v_run.stripe_payment_intent_id is not null or
     not exists(select 1 from public.resident_charge_payment_slots
       where charge_id = v_charge.id and autopay_run_id = p_run_id) or
     v_charge.manager_user_id is distinct from v_run.manager_id or
     v_charge.row_data->>'managerUserId' is distinct from v_run.manager_id::text or
     v_charge.row_data->>'id' is distinct from v_charge.id or
     v_charge.resident_user_id is distinct from v_run.resident_user_id or
     lower(v_charge.resident_email) is distinct from lower(trim(p_resident_email)) or
     lower(v_charge.row_data->>'residentEmail') is distinct from lower(trim(p_resident_email)) or
     public.resident_claim_charge_cents(v_charge.row_data) is distinct from p_principal_cents and
       v_run.status <> 'succeeded' then
    raise exception 'Autopay source or charge changed before settlement';
  end if;
  if nullif(trim(v_charge.property_id), '') is not null then
    select manager_user_id into v_owner from public.manager_property_records
      where id = v_charge.property_id for share;
    if not found or v_owner is distinct from v_run.manager_id then
      raise exception 'Autopay charge owner requires payment review';
    end if;
  end if;
  if v_run.status = 'succeeded' then
    if v_charge.status <> 'paid' or v_charge.row_data->>'status' <> 'paid' or
       v_charge.row_data->>'stripeCheckoutSessionId' is distinct from p_payment_intent_id or
       (v_charge.row_data->>'paidAmountCents')::integer is distinct from p_principal_cents then
      raise exception 'Autopay paid receipt differs from frozen source';
    end if;
    return jsonb_build_object('row',v_charge.row_data,'newlySettled',false);
  end if;
  if v_charge.status not in ('pending','failed') or
     v_charge.row_data->>'status' not in ('pending','failed') or
     public.resident_claim_charge_cents(v_charge.row_data) is distinct from p_principal_cents then
    raise exception 'Autopay charge is no longer payable';
  end if;
  v_paid_at := now();
  v_next := (v_charge.row_data - 'stripePaymentStatus') ||
    jsonb_build_object('status','paid','paidAt',v_paid_at,'balanceLabel','$0.00',
      'paidAmountCents',p_principal_cents,'stripeCheckoutSessionId',p_payment_intent_id,
      'stripePaymentStatus','succeeded');
  update public.portal_household_charge_records set status='paid',row_data=v_next,
    updated_at=v_paid_at where id=v_charge.id;
  update public.resident_autopay_runs set status='succeeded',
    stripe_payment_intent_id=p_payment_intent_id, failure_reason=null,updated_at=v_paid_at
    where id=p_run_id;
  return jsonb_build_object('row',v_next,'newlySettled',true);
end;
$$;

-- Called only after the exact PI is verified terminal-failed and the run has
-- recorded that failure. An absent/uncertain PI leaves the slot held.
create or replace function public.release_resident_autopay_slot(
  p_run_id uuid, p_attempt integer, p_payment_intent_id text
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_run public.resident_autopay_runs%rowtype;
begin
  if nullif(trim(p_payment_intent_id),'') is null then return false; end if;
  select * into v_run from public.resident_autopay_runs where id = p_run_id;
  if not found then return false; end if;
  perform 1 from public.portal_household_charge_records where id = v_run.charge_id for update;
  select * into v_run from public.resident_autopay_runs where id = p_run_id for update;
  if v_run.status <> 'failed' or v_run.attempt is distinct from p_attempt or
     v_run.stripe_payment_intent_id is distinct from p_payment_intent_id then return false; end if;
  delete from public.resident_charge_payment_slots where charge_id = v_run.charge_id
    and autopay_run_id = p_run_id;
  return found;
end;
$$;

revoke all on function public.resident_claim_charge_cents(jsonb) from public, anon, authenticated;
revoke all on function public.resident_checkout_attempt_immutable_terms() from public, anon, authenticated;
revoke all on function public.resident_checkout_payer_matches(uuid,text,text,uuid,text,uuid,text) from public, anon, authenticated;
revoke all on function public.reserve_resident_checkout_attempt(uuid,uuid,text,uuid,text[],integer[],integer,integer,integer,text,jsonb) from public, anon, authenticated;
revoke all on function public.mark_resident_checkout_processing(uuid,uuid,text) from public, anon, authenticated;
revoke all on function public.settle_resident_checkout_attempt(uuid,uuid,text,text) from public, anon, authenticated;
revoke all on function public.bind_resident_checkout_session(uuid,uuid,text) from public, anon, authenticated;
revoke all on function public.retire_resident_checkout_attempt(uuid,uuid,text,text) from public, anon, authenticated;
revoke all on function public.reserve_resident_autopay_slot(uuid,integer) from public, anon, authenticated;
revoke all on function public.bind_resident_autopay_payment_intent(uuid,integer,text) from public, anon, authenticated;
revoke all on function public.settle_resident_autopay_run(uuid,integer,text,integer,text) from public, anon, authenticated;
revoke all on function public.release_resident_autopay_slot(uuid,integer,text) from public, anon, authenticated;
grant execute on function public.resident_claim_charge_cents(jsonb) to service_role;
grant execute on function public.resident_checkout_attempt_immutable_terms() to service_role;
grant execute on function public.resident_checkout_payer_matches(uuid,text,text,uuid,text,uuid,text) to service_role;
grant execute on function public.reserve_resident_checkout_attempt(uuid,uuid,text,uuid,text[],integer[],integer,integer,integer,text,jsonb) to service_role;
grant execute on function public.mark_resident_checkout_processing(uuid,uuid,text) to service_role;
grant execute on function public.settle_resident_checkout_attempt(uuid,uuid,text,text) to service_role;
grant execute on function public.bind_resident_checkout_session(uuid,uuid,text) to service_role;
grant execute on function public.retire_resident_checkout_attempt(uuid,uuid,text,text) to service_role;
grant execute on function public.reserve_resident_autopay_slot(uuid,integer) to service_role;
grant execute on function public.bind_resident_autopay_payment_intent(uuid,integer,text) to service_role;
grant execute on function public.settle_resident_autopay_run(uuid,integer,text,integer,text) to service_role;
grant execute on function public.release_resident_autopay_slot(uuid,integer,text) to service_role;
