-- Read-only bulk wallet view for staff screens: one round trip for many owners,
-- each computed by the canonical comms_wallet_snapshot with p_apply=false.
-- Never creates accounts, resets periods, or grants credit.
create or replace function public.comms_wallet_snapshots(p_requests jsonb)
returns table(manager_user_id uuid, snapshot jsonb)
language plpgsql security definer set search_path=public,pg_temp set timezone='UTC' as $$
declare r jsonb;
begin
  if p_requests is null or jsonb_typeof(p_requests)<>'array' or jsonb_array_length(p_requests)>500 then
    raise exception 'Invalid wallet snapshot request';
  end if;
  for r in select value from jsonb_array_elements(p_requests) loop
    manager_user_id := (r->>'owner')::uuid;
    begin
      snapshot := public.comms_wallet_snapshot(manager_user_id,(r->>'allowance')::integer,(r->>'legacy_allowance')::integer,false);
    exception when others then
      snapshot := null;
    end;
    return next;
  end loop;
end $$;
revoke all on function public.comms_wallet_snapshots(jsonb) from public,anon,authenticated;
grant execute on function public.comms_wallet_snapshots(jsonb) to service_role;
