-- Bind provider evidence to a previously reserved attempt. Terminal and
-- reconciled states cannot be regressed by a late pending event.
create or replace function public.bind_security_deposit_refund(p_attempt uuid,p_refund text,p_charge text,p_amount bigint,p_status text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.security_deposit_return_attempts%rowtype; e public.platform_source_refund_evidence%rowtype;
begin
  select * into a from public.security_deposit_return_attempts where id=p_attempt for update;
  if not found or p_refund is null or p_charge is null or p_amount is distinct from a.refund_cents
    or p_status not in ('pending','succeeded','failed','canceled') then raise exception 'Refund binding requires review'; end if;
  if a.provider_refund_id is not null and a.provider_refund_id<>p_refund then raise exception 'Refund binding changed'; end if;
  select * into e from public.platform_source_refund_evidence where stripe_refund_id=p_refund;
  if not found or e.stripe_charge_id is distinct from p_charge or e.amount_cents is distinct from p_amount
     or e.status is distinct from p_status then raise exception 'Refund evidence requires review'; end if;
  if not exists(select 1 from public.ledger_entries where source_charge_id=a.source_charge_id and entry_type='payment'
      and manager_user_id=a.manager_user_id and stripe_charge_id=p_charge) then raise exception 'Refund source requires review'; end if;
  if a.status in ('succeeded','reconciled') and p_status in ('failed','canceled') then raise exception 'Refund terminal status changed'; end if;
  if a.status='failed' and p_status='succeeded' then raise exception 'Refund terminal status changed'; end if;
  update public.security_deposit_return_attempts set provider_refund_id=p_refund,
    status=case when a.status in ('reconciled','succeeded','failed') then a.status
      when p_status='canceled' then 'failed' else p_status end, updated_at=now()
    where id=a.id returning * into a;
  return to_jsonb(a);
end $$;
revoke all on function public.bind_security_deposit_refund(uuid,text,text,bigint,text) from public,anon,authenticated;
grant execute on function public.bind_security_deposit_refund(uuid,text,text,bigint,text) to service_role;

-- Provider refunds that did not carry a disposition attempt remain visible for review.
create table if not exists public.security_deposit_unmatched_refunds (
  stripe_refund_id text primary key,
  stripe_charge_id text not null,
  source_charge_id text not null,
  amount_cents bigint not null check (amount_cents>0),
  created_at timestamptz not null default now()
);
alter table public.security_deposit_unmatched_refunds enable row level security;
revoke all on public.security_deposit_unmatched_refunds from public,anon,authenticated;
grant all on public.security_deposit_unmatched_refunds to service_role;
