-- PropLane processing-fee coverage can again be unlocked by a promo code
-- (captain decision September 12, 2026, reversing the staff-only rule of
-- September 10). The manager-settings RPC used to downgrade any `proplane`
-- selection it could not match to a staff override. The server now validates the
-- grant (typed promo code, account promo grant, or staff approval) and tells the
-- RPC with `p_coverage_granted`; the RPC still never takes the staff override from
-- the caller, and a `proplane` with no grant still lands as `resident`.
--
-- The old two-argument signature is dropped rather than overloaded: with a
-- defaulted third argument both would match a two-argument call and Postgres
-- would refuse the call as ambiguous.

drop function if exists public.save_manager_payment_preferences(uuid, jsonb);

create or replace function public.save_manager_payment_preferences(
  p_owner uuid,
  p_settings jsonb,
  p_coverage_granted boolean default false
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare current_settings jsonb; next_settings jsonb;
begin
  if p_owner is null or jsonb_typeof(p_settings)<>'object' then raise exception 'Invalid payment settings'; end if;
  insert into public.manager_automation_settings(manager_user_id) values(p_owner) on conflict do nothing;
  select manual_payments into strict current_settings from public.manager_automation_settings where manager_user_id=p_owner for update;
  next_settings := p_settings-'adminServiceFeeOverride';
  if current_settings ? 'adminServiceFeeOverride' then
    next_settings := next_settings || jsonb_build_object('adminServiceFeeOverride',current_settings->'adminServiceFeeOverride');
  end if;
  if next_settings->>'serviceFeePayer'='proplane'
     and coalesce(p_coverage_granted,false) is not true
     and coalesce(current_settings->>'adminServiceFeeOverride','')<>'proplane' then
    next_settings := jsonb_set(next_settings,'{serviceFeePayer}','"resident"'::jsonb) - 'serviceFeeWaiverCode';
  end if;
  update public.manager_automation_settings set manual_payments=next_settings,updated_at=now() where manager_user_id=p_owner;
  return next_settings;
end $$;

revoke all on function public.save_manager_payment_preferences(uuid,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.save_manager_payment_preferences(uuid,jsonb,boolean) to service_role;
