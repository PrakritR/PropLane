-- Resident SMS completion is one subject-bound transaction. The caller is service-only.
create or replace function public.resolve_resident_dispatch_confirmation(p_run uuid, p_owner uuid, p_resident uuid, p_verdict text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.vendor_dispatch_runs%rowtype; w public.portal_work_order_records%rowtype; next_row jsonb; confirmation jsonb; requested timestamptz; confirmation_applied boolean := false; at_time timestamptz := now();
begin
  if p_run is null or p_owner is null or p_resident is null or p_verdict is null or p_verdict not in ('fixed','not_fixed') then return jsonb_build_object('applied',false); end if;
  if not pg_catalog.pg_try_advisory_xact_lock_shared(723081447301::bigint) then raise exception 'Account lifecycle transition in progress' using errcode='40001'; end if;
  perform 1 from auth.users where id=p_resident and deleted_at is null for key share;
  if not found or exists(select 1 from public.account_recovery_requests where user_id=p_resident and state in ('archiving','retained','recovering','purging')) then return jsonb_build_object('applied',false); end if;
  select * into r from public.vendor_dispatch_runs where id=p_run and owner_user_id=p_owner for update;
  if not found or r.source_type <> 'work_order' or r.status <> 'accepted' or r.completion_state <> 'awaiting_resident' then return jsonb_build_object('applied',false); end if;
  select * into w from public.portal_work_order_records where id=r.source_id and manager_user_id=p_owner and resident_user_id=p_resident for update;
  if not found then return jsonb_build_object('applied',false); end if;
  if pg_catalog.jsonb_typeof(w.row_data) is distinct from 'object' then return jsonb_build_object('applied',false); end if;
  -- An independently terminal service must never be reopened or overwritten.
  if pg_catalog.lower(pg_catalog.btrim(coalesce(w.row_data->>'bucket',''))) in ('completed','cancelled','canceled')
     or pg_catalog.lower(pg_catalog.btrim(coalesce(w.row_data->>'status',''))) in ('completed','cancelled','canceled')
     or nullif(w.row_data->>'completedAt','') is not null then
    return jsonb_build_object('applied',false);
  end if;
  next_row := w.row_data;
  confirmation := next_row->'residentConfirmation';
  if pg_catalog.jsonb_typeof(confirmation)='object' and nullif(confirmation->>'respondedAt','') is null then
    begin requested := (confirmation->>'requestedAt')::timestamptz;
    exception when invalid_datetime_format or datetime_field_overflow then requested := null; end;
    if requested is not null and requested + interval '7 days' >= at_time then
      next_row := jsonb_set(next_row,'{residentConfirmation}',confirmation || jsonb_build_object('respondedAt',at_time,'verdict',p_verdict),true);
      confirmation_applied := true;
    end if;
  end if;
  if p_verdict='fixed' then
    next_row := next_row || jsonb_build_object('bucket','completed','status','Completed','completedAt',at_time);
    if nullif(next_row->>'vendorCostCents','') is null and r.agreed_cents is not null then next_row := next_row || jsonb_build_object('vendorCostCents',r.agreed_cents); end if;
  else
    next_row := (next_row - 'automationStatus' - 'vendorMarkedDoneAt') || jsonb_build_object('reopenedAt',at_time);
  end if;
  update public.vendor_dispatch_runs set status=case when p_verdict='fixed' then 'completed' else status end,
    completion_state=case when p_verdict='fixed' then 'confirmed' else 'reopened' end,
    completed_at=case when p_verdict='fixed' then at_time else completed_at end,
    vendor_done_at=case when p_verdict='not_fixed' then null else vendor_done_at end, updated_at=at_time where id=r.id;
  update public.portal_work_order_records set row_data=next_row,updated_at=at_time where id=w.id and manager_user_id=p_owner and resident_user_id=p_resident;
  if not found then raise exception 'Service subject changed' using errcode='40001'; end if;
  return jsonb_build_object('applied',true,'run_id',r.id,'verdict',p_verdict,'confirmation_applied',confirmation_applied,'confirmation_requested_at',case when confirmation_applied then confirmation->>'requestedAt' else null end);
end $$;
revoke all on function public.resolve_resident_dispatch_confirmation(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.resolve_resident_dispatch_confirmation(uuid,uuid,uuid,text) to service_role;
