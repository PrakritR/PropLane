-- A general charge refund is reserved before the provider is called and projected onto the
-- household charge only from verified terminal provider evidence. Pending is not refunded money:
-- it reserves budget and nothing else. Additive only; no historical SQL is rewritten.
create table if not exists public.household_charge_refund_attempts (
  id uuid primary key default gen_random_uuid(),
  operation_key text not null unique,
  source_charge_id text not null,
  manager_user_id uuid references auth.users(id) on delete set null,
  stripe_charge_id text not null,
  stripe_payment_intent_id text,
  rail text not null check (rail in ('central','destination','managed')),
  platform_attempt_key text,
  amount_cents bigint not null check (amount_cents > 0),
  baseline_refunded_cents bigint not null check (baseline_refunded_cents >= 0),
  paid_cents bigint not null check (paid_cents > 0),
  basis jsonb not null check (jsonb_typeof(basis) = 'object'),
  provider_refund_id text unique,
  status text not null default 'reserved' check (status in ('reserved','pending','unknown','succeeded','failed')),
  projected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (amount_cents + baseline_refunded_cents <= paid_cents),
  check ((status = 'succeeded') = (projected_at is not null))
);
-- One unresolved reservation per household source: fail-closed concurrency, so two differing
-- amounts can never hold distinct provider keys against the same available balance.
create unique index if not exists household_charge_refund_one_unresolved
  on public.household_charge_refund_attempts(source_charge_id)
  where status in ('reserved','pending','unknown');
create index if not exists household_charge_refund_attempts_source
  on public.household_charge_refund_attempts(source_charge_id, status);
create unique index if not exists household_charge_refund_platform_key
  on public.household_charge_refund_attempts(platform_attempt_key)
  where platform_attempt_key is not null;
alter table public.household_charge_refund_attempts enable row level security;
revoke all on public.household_charge_refund_attempts from public, anon, authenticated;
grant all on public.household_charge_refund_attempts to service_role;

-- Reserve the exact component of the exact payment, under the charge's own row lock, against
-- authoritative payment evidence. The caller's operation key is the replay identity: the same key
-- with the same basis returns the stored state, a changed basis refuses.
create or replace function public.reserve_household_charge_refund(
  p_owner uuid, p_charge text, p_operation_key text, p_stripe_charge text,
  p_payment_intent text, p_rail text, p_amount bigint, p_basis jsonb
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.portal_household_charge_records%rowtype;
  pay public.ledger_entries%rowtype;
  a public.household_charge_refund_attempts%rowtype;
  refunded bigint; reserved_total bigint;
begin
  if p_owner is null or coalesce(trim(p_charge),'') = '' or coalesce(trim(p_operation_key),'') = ''
     or coalesce(trim(p_stripe_charge),'') = '' or p_rail not in ('central','destination','managed')
     or p_amount is null or p_amount <= 0 or jsonb_typeof(p_basis) is distinct from 'object' then
    raise exception 'Invalid refund reservation';
  end if;
  select * into c from public.portal_household_charge_records
    where id = p_charge and manager_user_id = p_owner for update;
  if not found then raise exception 'Refund source not found'; end if;
  if coalesce(c.row_data->>'refundedCents','0') !~ '^[0-9]+$' then raise exception 'Refund mirror requires reconciliation'; end if;
  refunded := coalesce((c.row_data->>'refundedCents')::bigint, 0);

  select * into pay from public.ledger_entries
    where source_charge_id = p_charge and entry_type = 'payment';
  if not found or pay.manager_user_id is distinct from p_owner
     or pay.stripe_charge_id is distinct from p_stripe_charge
     or pay.amount_cents is null or pay.amount_cents <= 0 then
    raise exception 'Refund payment evidence requires review';
  end if;

  select * into a from public.household_charge_refund_attempts where operation_key = p_operation_key;
  if found then
    -- Same operation: the ENTIRE immutable basis has to match, or this key is being reused for
    -- different money and must never resume the stored reservation.
    if a.source_charge_id is distinct from p_charge or a.manager_user_id is distinct from p_owner
       or a.stripe_charge_id is distinct from p_stripe_charge
       or a.stripe_payment_intent_id is distinct from p_payment_intent
       or a.rail is distinct from p_rail or a.amount_cents is distinct from p_amount
       or a.basis is distinct from p_basis then
      raise exception 'Operation key differs from reservation';
    end if;
    return to_jsonb(a);
  end if;

  select coalesce(sum(amount_cents),0) into reserved_total
    from public.household_charge_refund_attempts
    where source_charge_id = p_charge and status in ('reserved','pending','unknown');
  if refunded + reserved_total + p_amount > pay.amount_cents then
    raise exception 'Refund exceeds the payment''s available balance';
  end if;
  if exists (select 1 from public.household_charge_refund_attempts
      where source_charge_id = p_charge and status in ('reserved','pending','unknown')) then
    raise exception 'Refund requires reconciliation';
  end if;
  insert into public.household_charge_refund_attempts(
    operation_key, source_charge_id, manager_user_id, stripe_charge_id, stripe_payment_intent_id,
    rail, amount_cents, baseline_refunded_cents, paid_cents, basis)
    values(p_operation_key, p_charge, p_owner, p_stripe_charge, p_payment_intent,
      p_rail, p_amount, refunded, pay.amount_cents, p_basis)
    returning * into a;
  return to_jsonb(a);
end $$;
revoke all on function public.reserve_household_charge_refund(uuid,text,text,text,text,text,bigint,jsonb) from public, anon, authenticated;
grant execute on function public.reserve_household_charge_refund(uuid,text,text,text,text,text,bigint,jsonb) to service_role;

-- Record which platform reservation carries this household attempt, before the provider call can
-- be settled by the webhook. The binding is immutable once set.
create or replace function public.stamp_household_charge_refund_platform_key(p_attempt uuid, p_key text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.household_charge_refund_attempts%rowtype;
begin
  select * into a from public.household_charge_refund_attempts where id = p_attempt for update;
  if not found or coalesce(trim(p_key),'') = '' then raise exception 'Refund attempt not found'; end if;
  if a.platform_attempt_key is not null and a.platform_attempt_key <> p_key then
    raise exception 'Refund platform binding changed';
  end if;
  update public.household_charge_refund_attempts
    set platform_attempt_key = p_key, updated_at = now() where id = a.id returning * into a;
  return to_jsonb(a);
end $$;
revoke all on function public.stamp_household_charge_refund_platform_key(uuid,text) from public, anon, authenticated;
grant execute on function public.stamp_household_charge_refund_platform_key(uuid,text) to service_role;

-- Bind verified provider evidence and, for a succeeded refund only, project refundedCents onto
-- the charge exactly once under that charge's row lock. A late pending can never regress success.
create or replace function public.bind_household_charge_refund(
  p_attempt uuid, p_refund text, p_charge text, p_amount bigint, p_currency text,
  p_status text, p_platform_attempt uuid
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a public.household_charge_refund_attempts%rowtype;
  e public.platform_source_refund_evidence%rowtype;
  h public.platform_hold_refund_attempts%rowtype;
  c public.portal_household_charge_records%rowtype;
  refunded bigint; nowts timestamptz := now();
begin
  select * into a from public.household_charge_refund_attempts where id = p_attempt for update;
  if not found then raise exception 'Refund attempt not found'; end if;
  if p_refund is null or p_charge is null or coalesce(lower(p_currency),'usd') <> 'usd'
     or p_status not in ('pending','succeeded','failed','canceled')
     or p_charge is distinct from a.stripe_charge_id or p_amount is distinct from a.amount_cents then
    raise exception 'Refund binding requires review';
  end if;
  if a.provider_refund_id is not null and a.provider_refund_id <> p_refund then
    raise exception 'Refund binding changed';
  end if;
  -- Server-reread provider evidence only; an event snapshot never binds on its own.
  select * into e from public.platform_source_refund_evidence where stripe_refund_id = p_refund;
  if not found or e.stripe_charge_id is distinct from p_charge
     or e.amount_cents is distinct from p_amount or e.status is distinct from p_status then
    raise exception 'Refund evidence requires review';
  end if;
  if a.rail = 'central' then
    if p_platform_attempt is null then raise exception 'Central refund reservation required'; end if;
    select * into h from public.platform_hold_refund_attempts where id = p_platform_attempt;
    if not found or h.owner_user_id is distinct from a.manager_user_id
       or h.source_charge_id is distinct from a.stripe_charge_id
       or h.gross_cents is distinct from a.amount_cents
       or h.attempt_key is distinct from a.platform_attempt_key
       or jsonb_typeof(h.refund_components) is distinct from 'array'
       or jsonb_array_length(h.refund_components) <> 1
       or h.refund_components->0->>'source_id' is distinct from a.source_charge_id
       or (h.refund_components->0->>'principal_cents')::numeric is distinct from a.amount_cents then
      raise exception 'Refund component requires review';
    end if;
  end if;
  if a.status = 'succeeded' and p_status in ('failed','canceled') then raise exception 'Refund terminal status changed'; end if;
  if a.status = 'failed' and p_status = 'succeeded' then raise exception 'Refund terminal status changed'; end if;
  if a.status = 'succeeded' then
    update public.household_charge_refund_attempts set provider_refund_id = p_refund, updated_at = nowts
      where id = a.id returning * into a;
    return to_jsonb(a);
  end if;
  if p_status <> 'succeeded' then
    update public.household_charge_refund_attempts set provider_refund_id = p_refund,
      status = case when p_status = 'canceled' then 'failed' else p_status end, updated_at = nowts
      where id = a.id returning * into a;
    return to_jsonb(a);
  end if;

  select * into c from public.portal_household_charge_records
    where id = a.source_charge_id and manager_user_id = a.manager_user_id for update;
  if not found then raise exception 'Refund source not found'; end if;
  if coalesce(c.row_data->>'refundedCents','0') !~ '^[0-9]+$' then raise exception 'Refund mirror requires reconciliation'; end if;
  refunded := coalesce((c.row_data->>'refundedCents')::bigint, 0);
  -- The historical figure is the baseline and is preserved: pre-migration refunds are never
  -- replayed into it, and money never un-refunds.
  if refunded < a.baseline_refunded_cents then raise exception 'Refund mirror requires reconciliation'; end if;
  if refunded + a.amount_cents > a.paid_cents then raise exception 'Refund mirror exceeds the payment'; end if;
  -- Only the money keys are written, so a concurrent edit to any other field survives.
  update public.portal_household_charge_records set row_data =
      jsonb_set(
        jsonb_set(
          jsonb_set(coalesce(row_data,'{}'::jsonb), '{refundedCents}', to_jsonb(refunded + a.amount_cents), true),
          '{lastRefundedAt}', to_jsonb(to_char(nowts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), true),
        '{lastRefundOperationKey}', to_jsonb(a.operation_key), true),
    updated_at = nowts where id = c.id;
  update public.household_charge_refund_attempts set provider_refund_id = p_refund,
    status = 'succeeded', projected_at = nowts, updated_at = nowts
    where id = a.id returning * into a;
  return to_jsonb(a);
end $$;
revoke all on function public.bind_household_charge_refund(uuid,text,text,bigint,text,text,uuid) from public, anon, authenticated;
grant execute on function public.bind_household_charge_refund(uuid,text,text,bigint,text,text,uuid) to service_role;

-- Attach the same recovery guards every account-owned table carries, refusing a conflicting trigger.
do $household_refund_recovery_guards$
declare
  target_table oid; write_guard_function oid; capture_delete_function oid; existing_trigger record;
begin
  select c.oid into target_table from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'household_charge_refund_attempts' and c.relkind in ('r','p');
  select p.oid into write_guard_function from pg_proc p
    where p.oid = to_regprocedure('public.account_recovery_write_guard()') and p.prorettype = 'pg_catalog.trigger'::regtype;
  select p.oid into capture_delete_function from pg_proc p
    where p.oid = to_regprocedure('public.account_recovery_capture_delete()') and p.prorettype = 'pg_catalog.trigger'::regtype;
  if target_table is null or write_guard_function is null or capture_delete_function is null then
    raise exception 'recovery guard prerequisites missing for household_charge_refund_attempts';
  end if;

  select * into existing_trigger from pg_trigger where tgrelid = target_table and tgname = 'account_recovery_write_guard';
  if found then
    if existing_trigger.tgisinternal or existing_trigger.tgfoid <> write_guard_function
      or existing_trigger.tgtype <> 31 or existing_trigger.tgattr::text <> ''
      or existing_trigger.tgenabled <> 'O' or existing_trigger.tgnargs <> 0
      or existing_trigger.tgqual is not null or existing_trigger.tgconstraint <> 0 then
      raise exception 'household_charge_refund_attempts account_recovery_write_guard conflicts with the required recovery trigger';
    end if;
  else
    create trigger account_recovery_write_guard before insert or update or delete
      on public.household_charge_refund_attempts for each row execute function public.account_recovery_write_guard();
  end if;

  select * into existing_trigger from pg_trigger where tgrelid = target_table and tgname = 'account_recovery_capture_delete';
  if found then
    if existing_trigger.tgisinternal or existing_trigger.tgfoid <> capture_delete_function
      or existing_trigger.tgtype <> 9 or existing_trigger.tgattr::text <> ''
      or existing_trigger.tgenabled <> 'O' or existing_trigger.tgnargs <> 0
      or existing_trigger.tgqual is not null or existing_trigger.tgconstraint <> 0 then
      raise exception 'household_charge_refund_attempts account_recovery_capture_delete conflicts with the required recovery trigger';
    end if;
  else
    create trigger account_recovery_capture_delete after delete
      on public.household_charge_refund_attempts for each row execute function public.account_recovery_capture_delete();
  end if;
end
$household_refund_recovery_guards$;
