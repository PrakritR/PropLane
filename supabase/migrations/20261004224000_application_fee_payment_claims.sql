-- One application fee Checkout attempt per persisted application draft. The
-- provider create arguments are immutable for retries of an ambiguous create;
-- the paid session must match this claim before any charge or ledger write.
create table if not exists public.application_fee_payment_claims (
  application_id text primary key,
  manager_user_id uuid not null references auth.users(id) on delete cascade,
  property_id text not null,
  resident_email text not null,
  charge_id text not null unique,
  attempt_token uuid not null default gen_random_uuid(),
  stripe_session_id text unique,
  stripe_charge_id text,
  principal_cents integer not null check (principal_cents > 0),
  processing_fee_cents integer not null check (processing_fee_cents >= 0),
  payer_total_cents integer not null check (payer_total_cents = principal_cents + processing_fee_cents),
  recipient_net_cents integer not null check (recipient_net_cents > 0 and recipient_net_cents <= principal_cents),
  provider_params jsonb not null,
  draft_updated_at timestamptz not null,
  charge_policy text not null check (charge_policy in ('first_only','every_time')),
  status text not null default 'pending' check (status in ('pending','settled','expired')),
  promotion_status text not null default 'pending' check (promotion_status in ('pending','complete','needs_review')),
  promotion_reason text,
  promoted_application_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists application_fee_payment_claims_manager_idx
  on public.application_fee_payment_claims(manager_user_id);
create index if not exists application_fee_payment_claims_resident_email_idx
  on public.application_fee_payment_claims(lower(resident_email));
create unique index if not exists application_fee_one_pending_per_manager_resident
  on public.application_fee_payment_claims(manager_user_id, lower(resident_email))
  where charge_policy = 'first_only' and status = 'pending';
alter table public.application_fee_payment_claims enable row level security;
revoke all on public.application_fee_payment_claims from public, anon, authenticated;
grant all on public.application_fee_payment_claims to service_role;

create or replace function public.reserve_application_fee_checkout(
  p_application_id text, p_manager_user_id uuid, p_property_id text,
  p_resident_email text, p_charge_id text, p_principal_cents integer,
  p_processing_fee_cents integer, p_recipient_net_cents integer,
  p_provider_params jsonb, p_draft_updated_at timestamptz, p_charge_policy text
) returns public.application_fee_payment_claims language plpgsql security definer
  set search_path = public, pg_temp as $$
declare
  v_app public.manager_application_records%rowtype;
  v_claim public.application_fee_payment_claims%rowtype;
begin
  if p_charge_policy = 'first_only' then
    perform pg_advisory_xact_lock(hashtextextended(p_manager_user_id::text || ':' || lower(p_resident_email), 0));
  end if;
  select * into v_app from public.manager_application_records
    where id = p_application_id for update;
  if not found or v_app.manager_user_id is distinct from p_manager_user_id or
     v_app.property_id is distinct from p_property_id or
     lower(v_app.resident_email) is distinct from lower(p_resident_email) then
    raise exception 'Application payment draft no longer matches the owner and applicant';
  end if;
  perform 1 from public.manager_property_records
    where id = p_property_id and manager_user_id = p_manager_user_id for share;
  if not found then raise exception 'Application listing owner changed before checkout'; end if;
  if v_app.row_data->>'bucket' is distinct from 'pending' or
     lower(coalesce(v_app.row_data->>'stage','')) in ('submitted','withdrawn','approved','denied') or
     nullif(v_app.row_data->>'withdrawnAt','') is not null or
     coalesce(v_app.row_data->'application'->>'applicationFeeWaived','false') = 'true' then
    raise exception 'Application no longer requires this payment';
  end if;
  if p_principal_cents <= 0 or p_processing_fee_cents < 0 or
     p_recipient_net_cents <= 0 or p_recipient_net_cents > p_principal_cents or
     jsonb_typeof(p_provider_params) is distinct from 'object' or
     p_charge_policy not in ('first_only','every_time') then
    raise exception 'Invalid application payment quote';
  end if;
  if p_charge_policy = 'first_only' then
    -- Lock this applicant's already saved drafts while evaluating the rule;
    -- an arbitrary recent-row limit is not proof that history is absent.
    perform 1 from public.manager_application_records h
      where h.manager_user_id = p_manager_user_id
        and lower(h.resident_email) = lower(p_resident_email)
        and h.id <> p_application_id for share;
    if exists (
      select 1 from public.manager_application_records h
        where h.manager_user_id = p_manager_user_id
          and lower(h.resident_email) = lower(p_resident_email)
          and h.id <> p_application_id
          and (coalesce(h.row_data->>'bucket','') <> 'pending' or
               lower(coalesce(h.row_data->>'stage','')) = 'submitted')
          and lower(coalesce(h.row_data->>'stage','')) <> 'withdrawn'
          and nullif(h.row_data->>'withdrawnAt','') is null
    ) or exists (
      select 1 from public.portal_household_charge_records c
        where c.manager_user_id = p_manager_user_id
          and lower(c.resident_email) = lower(p_resident_email)
          and c.kind = 'application_fee' and c.status = 'paid'
    ) or exists (
      select 1 from public.application_fee_payment_claims c
        where c.manager_user_id = p_manager_user_id
          and lower(c.resident_email) = lower(p_resident_email)
          and c.status = 'settled'
    ) then
      raise exception 'This applicant already has a waived application fee for this manager';
    end if;
  end if;

  select * into v_claim from public.application_fee_payment_claims
    where application_id = p_application_id for update;
  if found then
    if v_claim.status = 'settled' then raise exception 'Application fee is already paid'; end if;
    if v_claim.status = 'pending' then
      if v_app.updated_at is distinct from p_draft_updated_at then
        raise exception 'Application draft changed before payment resumed';
      end if;
      return v_claim;
    end if;
  end if;
  if v_app.updated_at is distinct from p_draft_updated_at then
    raise exception 'Application draft changed before payment was reserved';
  end if;
  if v_claim.status = 'expired' then
    update public.application_fee_payment_claims set
      attempt_token = gen_random_uuid(), stripe_session_id = null,
      stripe_charge_id = null, principal_cents = p_principal_cents,
      processing_fee_cents = p_processing_fee_cents,
      payer_total_cents = p_principal_cents + p_processing_fee_cents,
      recipient_net_cents = p_recipient_net_cents,
      provider_params = p_provider_params, draft_updated_at = p_draft_updated_at,
      charge_policy = p_charge_policy, status = 'pending', updated_at = now()
      where application_id = p_application_id returning * into v_claim;
    return v_claim;
  end if;
  insert into public.application_fee_payment_claims (
    application_id, manager_user_id, property_id, resident_email, charge_id,
    principal_cents, processing_fee_cents, payer_total_cents,
    recipient_net_cents, provider_params, draft_updated_at, charge_policy
  ) values (
    p_application_id, p_manager_user_id, p_property_id, lower(p_resident_email), p_charge_id,
    p_principal_cents, p_processing_fee_cents, p_principal_cents + p_processing_fee_cents,
    p_recipient_net_cents, p_provider_params, p_draft_updated_at, p_charge_policy
  ) returning * into v_claim;
  return v_claim;
end;
$$;

create or replace function public.record_application_fee_promotion_result(
  p_application_id text, p_session_id text, p_status text, p_reason text
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_status not in ('complete','needs_review') or nullif(p_reason,'') is null then
    raise exception 'Invalid application promotion result';
  end if;
  update public.application_fee_payment_claims set
    promotion_status = p_status, promotion_reason = left(p_reason, 120),
    promoted_application_id = case when p_status = 'complete' then p_application_id else null end,
    updated_at = now()
    where application_id = p_application_id and stripe_session_id = p_session_id
      and status = 'settled';
  return found;
end;
$$;

create or replace function public.bind_application_fee_checkout_session(
  p_application_id text, p_attempt_token uuid, p_session_id text
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_claim public.application_fee_payment_claims%rowtype;
begin
  select * into v_claim from public.application_fee_payment_claims
    where application_id = p_application_id for update;
  if not found or v_claim.status <> 'pending' or
     v_claim.attempt_token is distinct from p_attempt_token or
     (v_claim.stripe_session_id is not null and v_claim.stripe_session_id <> p_session_id) or
     nullif(p_session_id, '') is null then return false; end if;
  update public.application_fee_payment_claims
    set stripe_session_id = p_session_id, updated_at = now()
    where application_id = p_application_id;
  return true;
end;
$$;

create or replace function public.rotate_expired_application_fee_checkout(
  p_application_id text, p_attempt_token uuid, p_session_id text,
  p_principal_cents integer, p_processing_fee_cents integer,
  p_recipient_net_cents integer, p_provider_params jsonb,
  p_draft_updated_at timestamptz, p_charge_policy text
) returns public.application_fee_payment_claims language plpgsql security definer
  set search_path = public, pg_temp as $$
declare
  v_claim public.application_fee_payment_claims%rowtype;
  v_app public.manager_application_records%rowtype;
  v_manager uuid;
  v_email text;
begin
  if p_charge_policy = 'first_only' then
    select manager_user_id, resident_email into v_manager, v_email
      from public.application_fee_payment_claims where application_id = p_application_id;
    if v_manager is not null and v_email is not null then
      perform pg_advisory_xact_lock(hashtextextended(v_manager::text || ':' || v_email, 0));
    end if;
  end if;
  select * into v_app from public.manager_application_records
    where id = p_application_id for update;
  select * into v_claim from public.application_fee_payment_claims
    where application_id = p_application_id for update;
  if not found or v_claim.status <> 'pending' or
     v_claim.attempt_token is distinct from p_attempt_token or
     v_claim.stripe_session_id is distinct from p_session_id or
     p_principal_cents <= 0 or p_processing_fee_cents < 0 or
     p_recipient_net_cents <= 0 or p_recipient_net_cents > p_principal_cents or
     jsonb_typeof(p_provider_params) is distinct from 'object' or
     p_charge_policy not in ('first_only','every_time') or
     v_app.manager_user_id is distinct from v_claim.manager_user_id or
     v_app.property_id is distinct from v_claim.property_id or
     lower(v_app.resident_email) is distinct from v_claim.resident_email or
     v_app.row_data->>'bucket' is distinct from 'pending' or
     lower(coalesce(v_app.row_data->>'stage','')) in ('submitted','withdrawn','approved','denied') or
     nullif(v_app.row_data->>'withdrawnAt','') is not null or
     coalesce(v_app.row_data->'application'->>'applicationFeeWaived','false') = 'true' or
     v_app.updated_at is distinct from p_draft_updated_at then
    raise exception 'Application payment attempt cannot rotate';
  end if;
  perform 1 from public.manager_property_records
    where id = v_claim.property_id and manager_user_id = v_claim.manager_user_id for share;
  if not found then raise exception 'Application listing owner changed before checkout retry'; end if;
  if p_charge_policy = 'first_only' then
    perform 1 from public.manager_application_records h
      where h.manager_user_id = v_claim.manager_user_id
        and lower(h.resident_email) = v_claim.resident_email
        and h.id <> p_application_id for share;
  end if;
  if p_charge_policy = 'first_only' and (
    exists (select 1 from public.manager_application_records h
      where h.manager_user_id = v_claim.manager_user_id
        and lower(h.resident_email) = v_claim.resident_email
        and h.id <> p_application_id
        and (coalesce(h.row_data->>'bucket','') <> 'pending' or lower(coalesce(h.row_data->>'stage','')) = 'submitted')
        and lower(coalesce(h.row_data->>'stage','')) <> 'withdrawn'
        and nullif(h.row_data->>'withdrawnAt','') is null)
    or exists (select 1 from public.portal_household_charge_records c
      where c.manager_user_id = v_claim.manager_user_id
        and lower(c.resident_email) = v_claim.resident_email
        and c.kind = 'application_fee' and c.status = 'paid')
    or exists (select 1 from public.application_fee_payment_claims c
      where c.manager_user_id = v_claim.manager_user_id
        and lower(c.resident_email) = v_claim.resident_email
        and c.application_id <> p_application_id and c.status = 'settled')
  ) then raise exception 'This applicant already has a waived application fee for this manager'; end if;
  update public.application_fee_payment_claims set
    attempt_token = gen_random_uuid(), stripe_session_id = null,
    principal_cents = p_principal_cents, processing_fee_cents = p_processing_fee_cents,
    payer_total_cents = p_principal_cents + p_processing_fee_cents,
    recipient_net_cents = p_recipient_net_cents,
    provider_params = p_provider_params, draft_updated_at = p_draft_updated_at,
    charge_policy = p_charge_policy,
    updated_at = now()
    where application_id = p_application_id returning * into v_claim;
  return v_claim;
end;
$$;

-- Caller must retrieve the Stripe session and prove status=expired first.
-- Never retire an unstamped/ambiguous create or a paid attempt.
create or replace function public.retire_expired_application_fee_checkout(
  p_application_id text, p_attempt_token uuid, p_session_id text
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.application_fee_payment_claims set status = 'expired', updated_at = now()
    where application_id = p_application_id and status = 'pending'
      and attempt_token = p_attempt_token and stripe_session_id = p_session_id
      and nullif(p_session_id,'') is not null;
  return found;
end;
$$;

create or replace function public.settle_application_fee_checkout(
  p_application_id text, p_attempt_token uuid, p_session_id text,
  p_stripe_charge_id text, p_charge_row_data jsonb
) returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_claim public.application_fee_payment_claims%rowtype;
  v_existing public.portal_household_charge_records%rowtype;
  v_manager uuid;
  v_email text;
  v_policy text;
begin
  -- Reserve takes this obligation lock before reading history and before
  -- locking the draft/claim. Settlement must take it in the same order: a
  -- second first-only draft can never pass its history read while the first
  -- payment is crossing from pending to settled.
  select manager_user_id, resident_email, charge_policy
    into v_manager, v_email, v_policy
    from public.application_fee_payment_claims where application_id = p_application_id;
  if v_policy = 'first_only' then
    perform pg_advisory_xact_lock(hashtextextended(v_manager::text || ':' || lower(v_email), 0));
  end if;
  select * into v_claim from public.application_fee_payment_claims
    where application_id = p_application_id for update;
  if not found or v_claim.attempt_token is distinct from p_attempt_token or
     (v_claim.stripe_session_id is not null and v_claim.stripe_session_id <> p_session_id) or
     nullif(p_session_id, '') is null or nullif(p_stripe_charge_id, '') is null or
     p_charge_row_data->>'applicationId' is distinct from v_claim.application_id or
     p_charge_row_data->>'stripeCheckoutSessionId' is distinct from p_session_id or
     p_charge_row_data->>'managerUserId' is distinct from v_claim.manager_user_id::text or
     p_charge_row_data->>'propertyId' is distinct from v_claim.property_id or
     lower(p_charge_row_data->>'residentEmail') is distinct from v_claim.resident_email or
     p_charge_row_data->>'kind' is distinct from 'application_fee' or
     p_charge_row_data->>'status' is distinct from 'paid' or
     p_charge_row_data->>'stripePaymentStatus' is distinct from 'paid' or
     nullif(p_charge_row_data->>'paidAt','') is null or
     (p_charge_row_data->>'paidAmountCents')::integer is distinct from v_claim.payer_total_cents then
    raise exception 'Paid application session does not match its durable claim';
  end if;
  select * into v_existing from public.portal_household_charge_records
    where id = v_claim.charge_id for update;
  if v_claim.status = 'settled' then
    if v_claim.stripe_session_id is distinct from p_session_id or
       v_claim.stripe_charge_id is distinct from p_stripe_charge_id or
       not found or v_existing.manager_user_id is distinct from v_claim.manager_user_id or
       v_existing.property_id is distinct from v_claim.property_id or
       lower(v_existing.resident_email) is distinct from v_claim.resident_email or
       v_existing.kind is distinct from 'application_fee' or
       v_existing.status not in ('paid','refunded') or
       v_existing.row_data->>'kind' is distinct from 'application_fee' or
       v_existing.row_data->>'managerUserId' is distinct from v_claim.manager_user_id::text or
       v_existing.row_data->>'propertyId' is distinct from v_claim.property_id or
       lower(v_existing.row_data->>'residentEmail') is distinct from v_claim.resident_email or
       v_existing.row_data->>'amountLabel' is distinct from p_charge_row_data->>'amountLabel' or
       v_existing.row_data->>'paidAmountCents' is distinct from p_charge_row_data->>'paidAmountCents' or
       v_existing.row_data->>'stripeCheckoutSessionId' is distinct from p_session_id or
       v_existing.row_data->>'paidAt' is distinct from p_charge_row_data->>'paidAt' then
      raise exception 'Paid application session changed on replay';
    end if;
    return v_claim.charge_id;
  end if;
  if found and (v_existing.manager_user_id is distinct from v_claim.manager_user_id or
     v_existing.property_id is distinct from v_claim.property_id or
     lower(v_existing.resident_email) is distinct from v_claim.resident_email or
     v_existing.kind is distinct from 'application_fee' or
     v_existing.status in ('paid','refunded') or
     (v_existing.row_data->>'stripeCheckoutSessionId' is not null and
      v_existing.row_data->>'stripeCheckoutSessionId' is distinct from p_session_id)) then
    raise exception 'Application fee charge belongs to another payment';
  end if;
  insert into public.portal_household_charge_records (
    id, manager_user_id, resident_email, property_id, kind, status, row_data, updated_at
  ) values (
    v_claim.charge_id, v_claim.manager_user_id, v_claim.resident_email,
    v_claim.property_id, 'application_fee', 'paid', p_charge_row_data, now()
  ) on conflict (id) do update set
    status = 'paid', row_data = excluded.row_data, updated_at = now();
  update public.application_fee_payment_claims set
    status = 'settled', stripe_session_id = p_session_id,
    stripe_charge_id = p_stripe_charge_id, updated_at = now()
    where application_id = p_application_id;
  return v_claim.charge_id;
end;
$$;

revoke all on function public.reserve_application_fee_checkout(text,uuid,text,text,text,integer,integer,integer,jsonb,timestamptz,text) from public,anon,authenticated;
revoke all on function public.bind_application_fee_checkout_session(text,uuid,text) from public,anon,authenticated;
revoke all on function public.rotate_expired_application_fee_checkout(text,uuid,text,integer,integer,integer,jsonb,timestamptz,text) from public,anon,authenticated;
revoke all on function public.retire_expired_application_fee_checkout(text,uuid,text) from public,anon,authenticated;
revoke all on function public.settle_application_fee_checkout(text,uuid,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.record_application_fee_promotion_result(text,text,text,text) from public,anon,authenticated;
grant execute on function public.reserve_application_fee_checkout(text,uuid,text,text,text,integer,integer,integer,jsonb,timestamptz,text) to service_role;
grant execute on function public.bind_application_fee_checkout_session(text,uuid,text) to service_role;
grant execute on function public.rotate_expired_application_fee_checkout(text,uuid,text,integer,integer,integer,jsonb,timestamptz,text) to service_role;
grant execute on function public.retire_expired_application_fee_checkout(text,uuid,text) to service_role;
grant execute on function public.settle_application_fee_checkout(text,uuid,text,text,jsonb) to service_role;
grant execute on function public.record_application_fee_promotion_result(text,text,text,text) to service_role;
