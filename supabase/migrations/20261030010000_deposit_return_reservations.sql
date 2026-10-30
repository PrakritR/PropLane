-- Reserve a provider return under the same deposit lock as offline dispositions.
-- A succeeded refund stays active until its accounting has been reconciled.
create table if not exists public.security_deposit_return_attempts (
  id uuid primary key default gen_random_uuid(),
  deposit_id uuid references public.security_deposit_ledger(id) on delete set null,
  manager_user_id uuid references auth.users(id) on delete set null,
  source_charge_id text not null,
  request_key text not null unique,
  expected_held_cents bigint not null check (expected_held_cents > 0),
  refund_cents bigint not null check (refund_cents > 0),
  withhold_cents bigint not null check (withhold_cents >= 0),
  itemization jsonb not null check (jsonb_typeof(itemization) = 'array'),
  provider_refund_id text unique,
  status text not null default 'reserved' check (status in ('reserved','pending','unknown','succeeded','failed','reconciled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (refund_cents + withhold_cents <= expected_held_cents)
);
create unique index if not exists security_deposit_return_one_active
  on public.security_deposit_return_attempts(deposit_id)
  where deposit_id is not null and status in ('reserved','pending','unknown','succeeded');
alter table public.security_deposit_return_attempts enable row level security;
revoke all on public.security_deposit_return_attempts from public, anon, authenticated;
grant all on public.security_deposit_return_attempts to service_role;

create or replace function public.reserve_security_deposit_return(
  p_owner uuid, p_deposit uuid, p_charge text, p_request_key text,
  p_expected_held bigint, p_refund bigint, p_withhold bigint, p_itemization jsonb
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare d public.security_deposit_ledger%rowtype; a public.security_deposit_return_attempts%rowtype; item_total numeric;
begin
  select * into d from public.security_deposit_ledger where id = p_deposit and manager_user_id = p_owner for update;
  if not found or d.source_charge_id is distinct from p_charge then raise exception 'Deposit not found'; end if;
  if p_request_key is null or length(trim(p_request_key)) = 0 or p_expected_held is null or p_refund is null or p_withhold is null
     or p_refund <= 0 or p_withhold < 0 or p_expected_held <= 0 or p_refund + p_withhold > p_expected_held
     or jsonb_typeof(p_itemization) is distinct from 'array' then raise exception 'Invalid return'; end if;
  if exists (select 1 from jsonb_array_elements(p_itemization) x where jsonb_typeof(x) <> 'object'
      or coalesce(trim(x->>'label'), '') = '' or coalesce(x->>'amountCents','') !~ '^[0-9]+$'
      or (x->>'amountCents')::numeric <= 0) then raise exception 'Invalid itemization'; end if;
  select coalesce(sum((x->>'amountCents')::numeric),0) into item_total from jsonb_array_elements(p_itemization) x;
  if item_total <> p_withhold then raise exception 'Itemization must equal withholding'; end if;
  select * into a from public.security_deposit_return_attempts where request_key = p_request_key;
  if found then
    if a.deposit_id is distinct from p_deposit or a.manager_user_id is distinct from p_owner
       or a.source_charge_id is distinct from p_charge or a.expected_held_cents is distinct from p_expected_held
       or a.refund_cents is distinct from p_refund or a.withhold_cents is distinct from p_withhold
       or a.itemization is distinct from p_itemization then raise exception 'Request key differs from reservation'; end if;
    return to_jsonb(a);
  end if;
  if d.amount_held_cents <> p_expected_held or d.status not in ('held','partially_refunded') then raise exception 'Deposit balance changed; review again'; end if;
  if exists (select 1 from public.security_deposit_return_attempts where deposit_id = d.id and status in ('reserved','pending','unknown','succeeded')) then
    raise exception 'Deposit return requires reconciliation';
  end if;
  insert into public.security_deposit_return_attempts(deposit_id,manager_user_id,source_charge_id,request_key,expected_held_cents,refund_cents,withhold_cents,itemization)
    values(d.id,p_owner,p_charge,p_request_key,p_expected_held,p_refund,p_withhold,p_itemization) returning * into a;
  return to_jsonb(a);
end $$;
revoke all on function public.reserve_security_deposit_return(uuid,uuid,text,text,bigint,bigint,bigint,jsonb) from public, anon, authenticated;
grant execute on function public.reserve_security_deposit_return(uuid,uuid,text,text,bigint,bigint,bigint,jsonb) to service_role;

-- The wrapper shares the deposit lock with reservation. The existing implementation
-- retains its history and journal semantics; it is no longer directly callable.
do $$ begin
  if to_regprocedure('public.commit_security_deposit_disposition_unreserved(uuid,uuid,bigint,bigint,bigint,text,date,jsonb,text,jsonb)') is null then
    alter function public.commit_security_deposit_disposition(uuid,uuid,bigint,bigint,bigint,text,date,jsonb,text,jsonb)
      rename to commit_security_deposit_disposition_unreserved;
  end if;
end $$;
revoke all on function public.commit_security_deposit_disposition_unreserved(uuid,uuid,bigint,bigint,bigint,text,date,jsonb,text,jsonb) from public, anon, authenticated, service_role;
create or replace function public.commit_security_deposit_disposition(
  p_owner uuid, p_deposit uuid, p_expected_held bigint, p_refund bigint, p_withhold bigint,
  p_type text, p_date date, p_itemization jsonb, p_memo text, p_history jsonb default null
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform 1 from public.security_deposit_ledger where id = p_deposit and manager_user_id = p_owner for update;
  if not found then raise exception 'Deposit not found'; end if;
  if exists (select 1 from public.security_deposit_return_attempts where deposit_id = p_deposit and status in ('reserved','pending','unknown','succeeded')) then
    raise exception 'Deposit return requires reconciliation';
  end if;
  return public.commit_security_deposit_disposition_unreserved(p_owner,p_deposit,p_expected_held,p_refund,p_withhold,p_type,p_date,p_itemization,p_memo,p_history);
end $$;
revoke all on function public.commit_security_deposit_disposition(uuid,uuid,bigint,bigint,bigint,text,date,jsonb,text,jsonb) from public, anon, authenticated;
grant execute on function public.commit_security_deposit_disposition(uuid,uuid,bigint,bigint,bigint,text,date,jsonb,text,jsonb) to service_role;
