-- Atomic monthly alert claims; no event pagination on the delivery path.
create or replace function public.claim_comms_budget_alert(p_owner uuid)
returns jsonb language plpgsql security definer set search_path=public set timezone='UTC' as $$
declare a public.manager_comms_billing_accounts%rowtype; used bigint; threshold integer; month_start timestamptz := date_trunc('month',now());
begin
  select * into a from public.manager_comms_billing_accounts where manager_user_id=p_owner for update;
  if not found or coalesce(a.monthly_budget_cents,0)<=0 then return null; end if;
  select coalesce(sum(total_cents),0) into used from public.manager_comms_usage_events
    where manager_user_id=p_owner and created_at>=month_start and created_at<month_start+interval '1 month' and credit_state<>'released';
  if used>=a.monthly_budget_cents then
    if a.notified_budget_100_at>=month_start then return null; end if;
    threshold:=100;
    update public.manager_comms_billing_accounts set notified_budget_100_at=now(),notified_budget_80_at=now() where manager_user_id=p_owner;
  elsif used*100>=a.monthly_budget_cents*80 then
    if a.notified_budget_80_at>=month_start then return null; end if;
    threshold:=80;
    update public.manager_comms_billing_accounts set notified_budget_80_at=now() where manager_user_id=p_owner;
  else return null;
  end if;
  return jsonb_build_object('threshold',threshold,'used',used,'budget',a.monthly_budget_cents);
end $$;
revoke all on function public.claim_comms_budget_alert(uuid) from public,anon,authenticated;
grant execute on function public.claim_comms_budget_alert(uuid) to service_role;
alter function public.comms_wallet_snapshot(uuid,integer,integer,boolean) set timezone='UTC';
