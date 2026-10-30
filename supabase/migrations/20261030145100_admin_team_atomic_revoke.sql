-- p_plan is an internal server-normalized grant, never the request body. The
-- RPC re-derives durable ownership and rejects stale seat/property context.
create or replace function public.demote_admin_team_role(p_actor uuid, p_target uuid, p_plan jsonb, p_expected_seats jsonb, p_via text)
returns text language plpgsql security definer set search_path = '' as $$
declare item jsonb; seat record; workspace record; grant_data jsonb; target_profile record; owner_profile record; seat_id uuid; target_axis text; owner_axis text; assigned jsonb; expected jsonb; actual jsonb;
begin
  if p_actor is null or p_target is null or p_plan is null or p_expected_seats is null or p_via is null or p_via not in ('change','remove') or pg_catalog.jsonb_typeof(p_plan) <> 'array' or pg_catalog.jsonb_typeof(p_expected_seats) <> 'array' then return 'invalid'; end if;
  perform pg_catalog.pg_advisory_xact_lock(723081447301::bigint);
  if not exists(select 1 from public.profile_roles where user_id=p_actor and role='admin') then return 'forbidden'; end if;
  select * into target_profile from public.profiles where id=p_target for update;
  if not found then return 'stale'; end if;
  perform 1 from public.profile_roles where user_id=p_target order by role for update;
  if not exists(select 1 from public.profile_roles where user_id=p_target and role='admin') then return 'already_revoked'; end if;
  if (select count(*) from public.profile_roles where role='admin') <= 1 then return 'last_admin'; end if;
  -- Lock selected and existing affected workspaces in a single deterministic order.
  perform w.id from public.portal_workspaces w
    where w.id in (select s.workspace_id from public.account_link_invites s where s.invitee_user_id=p_target and s.is_service_seat=true and coalesce(s.is_owner_of_record,false)=false and s.team_role is distinct from 'property_owner' and s.status in ('accepted','pending'))
       or w.id in (select (x->>'workspaceId')::uuid from pg_catalog.jsonb_array_elements(p_plan) x)
    order by w.id for update;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',s.id,'status',s.status,'workspaceId',s.workspace_id,'role',s.team_role,'inviterUserId',s.inviter_user_id,'houseScope',s.house_scope,'assignedPropertyIds',s.assigned_property_ids,'propertyCoManagerPermissions',s.property_co_manager_permissions,'coManagerPermissions',s.co_manager_permissions,'workspacePermissions',s.workspace_permissions) order by s.id),'[]'::jsonb)
    into actual from public.account_link_invites s where s.invitee_user_id=p_target and s.is_service_seat=true and coalesce(s.is_owner_of_record,false)=false and s.team_role is distinct from 'property_owner' and s.status in ('accepted','pending') and exists(select 1 from public.portal_workspaces w where w.id=s.workspace_id and w.is_service=true);
  select coalesce(pg_catalog.jsonb_agg(e order by e->>'id'),'[]'::jsonb) into expected from pg_catalog.jsonb_array_elements(p_expected_seats) e;
  if actual <> expected then return 'stale'; end if;
  if exists(select 1 from public.account_link_invites s join public.portal_workspaces w on w.id=s.workspace_id where s.invitee_user_id=p_target and s.is_service_seat=true and coalesce(s.is_owner_of_record,false)=false and s.team_role is distinct from 'property_owner' and s.status in ('accepted','pending') and w.is_service=true and s.inviter_user_id<>w.owner_user_id) then return 'stale'; end if;
  if exists(select 1 from pg_catalog.jsonb_array_elements(p_plan) x group by x->>'workspaceId' having count(*)>1) then return 'invalid'; end if;
  -- Validate every selected workspace and property before any mutation.
  for item in select value from pg_catalog.jsonb_array_elements(p_plan) order by value->>'workspaceId' loop
    grant_data := item->'grant'; assigned := grant_data->'assignedPropertyIds';
    if item->>'workspaceId' is null or item->>'ownerUserId' is null or grant_data is null or pg_catalog.jsonb_typeof(grant_data) is distinct from 'object' or pg_catalog.jsonb_typeof(assigned) is distinct from 'array'
       or pg_catalog.jsonb_typeof(grant_data->'propertyCoManagerPermissions') is distinct from 'object'
       or pg_catalog.jsonb_typeof(grant_data->'coManagerPermissions') is distinct from 'object'
       or pg_catalog.jsonb_typeof(grant_data->'workspacePermissions') is distinct from 'object'
       or grant_data->>'teamRole' is null or grant_data->>'teamRole' not in ('viewer','leasing','property_manager','bookkeeper','maintenance','admin','full','custom')
       or grant_data->>'houseScope' is null or grant_data->>'houseScope' not in ('all','selected') then return 'invalid'; end if;
    select w.id,w.owner_user_id into workspace from public.portal_workspaces w where w.id=(item->>'workspaceId')::uuid and w.is_service=true for update;
    if not found or workspace.owner_user_id::text is distinct from item->>'ownerUserId' or workspace.owner_user_id=p_target then return 'stale'; end if;
    perform 1 from public.profiles where id=workspace.owner_user_id for update;
    if not found then return 'stale'; end if;
    if (select count(*) from pg_catalog.jsonb_array_elements_text(assigned)) <> (select count(distinct v) from pg_catalog.jsonb_array_elements_text(assigned) v) then return 'invalid'; end if;
    if exists(select 1 from pg_catalog.jsonb_array_elements_text(assigned) v where not exists(select 1 from public.manager_property_records p where p.id=v and p.workspace_id=workspace.id and p.manager_user_id=workspace.owner_user_id)) then return 'stale'; end if;
    if grant_data->>'houseScope'='all' and (select count(*) from public.manager_property_records p where p.workspace_id=workspace.id and p.manager_user_id=workspace.owner_user_id) <> pg_catalog.jsonb_array_length(assigned) then return 'stale'; end if;
    if exists(select 1 from public.account_link_invites s where s.invitee_user_id=p_target and s.workspace_id=workspace.id and s.status in ('accepted','pending') and (s.is_service_seat is distinct from true or s.is_owner_of_record is true)) then return 'stale'; end if;
  end loop;
  -- All writes and their audit entries remain in this transaction.
  insert into public.audit_log(actor_user_id,landlord_id,action,tool_name,input_summary,result_summary,dedupe_key)
    values(p_actor,p_actor,'admin_team_revoke','admin_team_revoke',pg_catalog.jsonb_build_object('targetUserId',p_target,'role','overall_admin','via',p_via),'{"applied":true}'::jsonb,'admin_team_revoke:' || pg_catalog.gen_random_uuid()::text);
  delete from public.profile_roles where user_id=p_target and role='admin';
  update public.profiles set role=(select role from public.profile_roles where user_id=p_target order by role limit 1) where id=p_target and role='admin' and exists(select 1 from public.profile_roles where user_id=p_target);
  for seat in select * from public.account_link_invites s where s.invitee_user_id=p_target and s.is_service_seat=true and coalesce(s.is_owner_of_record,false)=false and s.team_role is distinct from 'property_owner' and s.status in ('accepted','pending') and exists(select 1 from public.portal_workspaces w where w.id=s.workspace_id and w.is_service=true) and not exists(select 1 from pg_catalog.jsonb_array_elements(p_plan) x where x->>'workspaceId'=s.workspace_id::text) loop
    insert into public.audit_log(actor_user_id,landlord_id,action,tool_name,input_summary,result_summary,dedupe_key) values(p_actor,seat.inviter_user_id,'admin_service_team_remove','admin_service_team_remove',pg_catalog.jsonb_build_object('workspaceId',seat.workspace_id,'linkId',seat.id,'targetRole',seat.team_role,'wasStatus',seat.status),'{"applied":true}'::jsonb,'admin_service_team_remove:'||pg_catalog.gen_random_uuid()::text);
    update public.account_link_invites set status='cancelled',responded_at=pg_catalog.now() where id=seat.id;
  end loop;
  for item in select value from pg_catalog.jsonb_array_elements(p_plan) order by value->>'workspaceId' loop
    grant_data:=item->'grant';
    select * into workspace from public.portal_workspaces where id=(item->>'workspaceId')::uuid;
    select * into owner_profile from public.profiles where id=workspace.owner_user_id for update;
    if not found then raise exception 'Owner profile unavailable'; end if;
    owner_axis:=nullif(pg_catalog.btrim(owner_profile.manager_id),''); target_axis:=nullif(pg_catalog.btrim(target_profile.manager_id),'');
    if owner_axis is null then owner_axis:='PROPLANE-'||pg_catalog.upper(pg_catalog.substr(pg_catalog.replace(pg_catalog.gen_random_uuid()::text,'-',''),1,8)); update public.profiles set manager_id=owner_axis where id=workspace.owner_user_id and nullif(pg_catalog.btrim(manager_id),'') is null; end if;
    if target_axis is null then target_axis:='PROPLANE-'||pg_catalog.upper(pg_catalog.substr(pg_catalog.replace(pg_catalog.gen_random_uuid()::text,'-',''),1,8)); update public.profiles set manager_id=target_axis where id=p_target and nullif(pg_catalog.btrim(manager_id),'') is null; target_profile.manager_id:=target_axis; end if;
    select s.id into seat_id from public.account_link_invites s where s.invitee_user_id=p_target and s.workspace_id=workspace.id and s.inviter_user_id=workspace.owner_user_id and s.status in ('accepted','pending') limit 1;
    insert into public.audit_log(actor_user_id,landlord_id,action,tool_name,input_summary,result_summary,dedupe_key) values(p_actor,workspace.owner_user_id,'admin_team_seat','admin_team_seat',pg_catalog.jsonb_build_object('workspaceId',workspace.id,'inviteeUserId',p_target,'teamRole',grant_data->>'teamRole','houseScope',grant_data->>'houseScope','houseCount',pg_catalog.jsonb_array_length(grant_data->'assignedPropertyIds'),'via','change','replacesLinkId',seat_id),'{"applied":true}'::jsonb,'admin_team_seat:'||pg_catalog.gen_random_uuid()::text);
    if seat_id is null then
      insert into public.account_link_invites(inviter_user_id,invitee_user_id,tab_kind,inviter_axis_id,invitee_axis_id,inviter_display_name,invitee_display_name,assigned_property_ids,payout_percent_for_manager,property_co_manager_permissions,co_manager_permissions,workspace_id,workspace_permissions,team_role,house_scope,invited_via,invited_at,responded_at,status,is_owner_of_record,is_service_seat)
      values(workspace.owner_user_id,p_target,'manager',owner_axis,target_axis,coalesce(nullif(pg_catalog.btrim(owner_profile.full_name),''),owner_profile.email),coalesce(nullif(pg_catalog.btrim(target_profile.full_name),''),target_profile.email),grant_data->'assignedPropertyIds',0,grant_data->'propertyCoManagerPermissions',grant_data->'coManagerPermissions',workspace.id,grant_data->'workspacePermissions',grant_data->>'teamRole',grant_data->>'houseScope','code',pg_catalog.now(),pg_catalog.now(),'accepted',false,true);
    else
      update public.account_link_invites set status='accepted',responded_at=pg_catalog.now(),team_role=grant_data->>'teamRole',house_scope=grant_data->>'houseScope',assigned_property_ids=grant_data->'assignedPropertyIds',property_co_manager_permissions=grant_data->'propertyCoManagerPermissions',co_manager_permissions=grant_data->'coManagerPermissions',workspace_permissions=grant_data->'workspacePermissions',is_service_seat=true where id=seat_id;
    end if;
  end loop;
  return 'revoked';
end $$;
revoke all on function public.demote_admin_team_role(uuid,uuid,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.demote_admin_team_role(uuid,uuid,jsonb,jsonb,text) to service_role;
