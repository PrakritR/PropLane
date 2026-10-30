-- Preserve a review queue and allow an operator or webhook replay to retry it.
alter table public.security_deposit_unmatched_refunds add column if not exists status text not null default 'review' check (status in ('review','reconciled'));
alter table public.security_deposit_unmatched_refunds add column if not exists reason text not null default 'Awaiting canonical refund accounting';
alter table public.security_deposit_unmatched_refunds add column if not exists updated_at timestamptz not null default now();
do $$ begin
  if not exists (
    select 1 from pg_constraint c where c.conrelid='public.security_deposit_unmatched_refunds'::regclass
      and c.contype='p' and pg_get_constraintdef(c.oid)='PRIMARY KEY (stripe_refund_id, source_charge_id)'
  ) then
    alter table public.security_deposit_unmatched_refunds drop constraint if exists security_deposit_unmatched_refunds_pkey;
    alter table public.security_deposit_unmatched_refunds add primary key (stripe_refund_id,source_charge_id);
  end if;
end $$;

create or replace function public.reconcile_external_security_deposit_refund(p_refund text,p_source text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare u public.security_deposit_unmatched_refunds%rowtype; d public.security_deposit_ledger%rowtype;
  a public.security_deposit_return_attempts%rowtype;
begin
  select * into u from public.security_deposit_unmatched_refunds where stripe_refund_id=p_refund and source_charge_id=p_source for update;
  if not found then raise exception 'Unmatched refund not found'; end if;
  if u.status='reconciled' then return to_jsonb(u); end if;
  begin
    select * into d from public.security_deposit_ledger where source_charge_id=p_source for update;
    if not found then raise exception 'Deposit not found'; end if;
    if d.status not in ('held','partially_refunded') or d.amount_held_cents<u.amount_cents then raise exception 'Deposit balance requires review'; end if;
    if exists(select 1 from public.security_deposit_return_attempts where deposit_id=d.id and status in ('reserved','pending','unknown','succeeded')) then
      raise exception 'An active return must be reconciled first'; end if;
    if not exists(select 1 from public.platform_source_refund_evidence where stripe_refund_id=p_refund and stripe_charge_id=u.stripe_charge_id
      and amount_cents=u.amount_cents and status='succeeded') then raise exception 'Exact succeeded provider evidence required'; end if;
    if exists(select 1 from public.security_deposit_return_attempts where provider_refund_id=p_refund) then raise exception 'Provider refund already belongs to another attempt'; end if;
    insert into public.security_deposit_return_attempts(deposit_id,manager_user_id,source_charge_id,request_key,expected_held_cents,refund_cents,withhold_cents,itemization,provider_refund_id,status)
      values(d.id,d.manager_user_id,p_source,'external:'||p_refund||':'||p_source,d.amount_held_cents,u.amount_cents,0,'[]'::jsonb,p_refund,'succeeded') returning * into a;
    perform public.settle_security_deposit_return(a.id);
    update public.security_deposit_unmatched_refunds set status='reconciled',reason='Canonical refund settled',updated_at=now()
      where stripe_refund_id=p_refund and source_charge_id=p_source returning * into u;
  exception when others then
    -- The subtransaction rolls back the candidate attempt and all settlement
    -- writes; the durable review row stays available for a later exact retry.
    update public.security_deposit_unmatched_refunds set status='review',reason=left(sqlerrm,500),updated_at=now()
      where stripe_refund_id=p_refund and source_charge_id=p_source returning * into u;
  end;
  return to_jsonb(u);
end $$;
revoke all on function public.reconcile_external_security_deposit_refund(text,text) from public,anon,authenticated;
grant execute on function public.reconcile_external_security_deposit_refund(text,text) to service_role;

-- A cart's Stripe charge is shared: a central reservation must name exactly
-- this deposit component, not merely share the same provider charge.
create or replace function public.bind_security_deposit_refund(p_attempt uuid,p_refund text,p_charge text,p_amount bigint,p_status text,p_platform_attempt uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.security_deposit_return_attempts%rowtype; h public.platform_hold_refund_attempts%rowtype;
begin
  select * into a from public.security_deposit_return_attempts where id=p_attempt;
  if not found then raise exception 'Return attempt not found'; end if;
  if p_platform_attempt is not null then
    select * into h from public.platform_hold_refund_attempts where id=p_platform_attempt;
    if not found or h.owner_user_id is distinct from a.manager_user_id or h.source_charge_id is distinct from p_charge
       or h.gross_cents is distinct from p_amount or jsonb_typeof(h.refund_components) is distinct from 'array'
       or jsonb_array_length(h.refund_components)<>1 or h.refund_components->0->>'source_id' is distinct from a.source_charge_id
       or (h.refund_components->0->>'principal_cents')::numeric is distinct from a.refund_cents then
      raise exception 'Refund component requires review';
    end if;
  elsif exists(select 1 from public.platform_payment_holds where stripe_charge_id=p_charge and source_allocation_mode='hold') then
    raise exception 'Central refund reservation required';
  end if;
  return public.bind_security_deposit_refund(p_attempt,p_refund,p_charge,p_amount,p_status);
end $$;
revoke all on function public.bind_security_deposit_refund(uuid,text,text,bigint,text) from service_role;
revoke all on function public.bind_security_deposit_refund(uuid,text,text,bigint,text,uuid) from public,anon,authenticated;
grant execute on function public.bind_security_deposit_refund(uuid,text,text,bigint,text,uuid) to service_role;
