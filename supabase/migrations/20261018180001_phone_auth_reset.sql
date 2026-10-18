-- W5: owner-mediated recovery is a release, never a new credential or session.
-- The caller supplies an authenticated actor; client roles cannot execute it.
create or replace function public.phone_auth_reset(
  p_actor uuid, p_target uuid, p_workspace uuid, p_phone text, p_operation uuid
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  target_profile_phone text;
  target_auth_phone text;
  target_contact_phone text;
  vendor_row text;
  authorized boolean := false;
  workspace_default boolean;
  remaining_providers jsonb;
begin
  if p_actor is null or p_target is null or p_actor = p_target or p_phone is null then return false; end if;
  if not exists(select 1 from public.sms_runtime_config where singleton and line_mode = 'shared') then return false; end if;
  if not exists(select 1 from public.profile_roles where user_id = p_actor and role = 'manager') then return false; end if;
  if not exists(select 1 from public.profiles where id = p_actor and phone_verified_at is not null and phone is not null)
    and not exists(select 1 from auth.users where id = p_actor and phone_confirmed_at is not null and phone is not null) then return false; end if;
  if not exists(select 1 from public.profile_roles where user_id = p_target and role in ('resident','vendor'))
    or exists(select 1 from public.profile_roles where user_id = p_target and role not in ('resident','vendor')) then return false; end if;

  select is_default into workspace_default from public.portal_workspaces
    where id = p_workspace and owner_user_id = p_actor for share;
  if not found then return false; end if;

  -- A manager-typed resident email is not consent to reset that login. Require
  -- the resident's self-authored binding AND its application in THIS workspace.
  if exists(select 1 from public.profile_roles where user_id = p_target and role = 'resident') then
    perform 1 from public.resident_workspace_bindings b
      join public.manager_application_records a on a.id = b.application_id and a.manager_user_id = p_actor
      join public.manager_property_records p on p.id = coalesce(nullif(a.assigned_property_id,''),nullif(a.property_id,''))
      where b.resident_user_id = p_target and b.manager_user_id = p_actor
        and p.manager_user_id = p_actor and p.workspace_id = p_workspace
      for share of b, a, p;
    authorized := found;
  end if;

  if not authorized and exists(select 1 from public.profile_roles where user_id = p_target and role = 'vendor') then
    -- Match portal-vendors' property-list scope: unassigned rosters belong only
    -- to the owner's default workspace. A catalog row alone grants no reset:
    -- an accepted invite or the vendor's own submitted bid proves the link.
    select v.id into vendor_row from public.manager_vendor_records v
      where v.manager_user_id = p_actor and v.vendor_user_id = p_target
        and coalesce(v.row_data->>'active','true') <> 'false'
        and (
          (workspace_default and (not (v.row_data ? 'propertyIds') or v.row_data->'propertyIds' = '[]'::jsonb))
          or exists(select 1 from public.manager_property_records p
            where p.manager_user_id = p_actor and p.workspace_id = p_workspace
              and jsonb_typeof(v.row_data->'propertyIds') = 'array' and (v.row_data->'propertyIds') ? p.id)
        )
        and (
          exists(select 1 from public.vendor_invites i where i.manager_user_id = p_actor
            and i.vendor_directory_id = v.id and i.accepted_user_id = p_target and i.status = 'accepted')
          or exists(select 1 from public.work_order_bids b
            join public.portal_work_order_records w on w.id = b.work_order_id and w.manager_user_id = p_actor
            join public.manager_property_records p on p.id = coalesce(nullif(w.assigned_property_id,''),nullif(w.property_id,''))
            where b.vendor_user_id = p_target and b.status in ('submitted','accepted')
              and p.manager_user_id = p_actor and p.workspace_id = p_workspace)
        )
      order by v.id limit 1 for share of v;
    authorized := found;
  end if;
  if not authorized then return false; end if;

  -- Share the bind lock order and prove that this request still owns both
  -- leases. A pending bind or reset cannot change the target under this reset.
  perform pg_advisory_xact_lock(hashtextextended('phone-auth-user:' || p_target::text,0));
  perform key from public.phone_auth_operation_locks
    where key in ('phone:' || p_phone, 'user:' || p_target::text) order by key for update;
  if (select count(*) from public.phone_auth_operation_locks
    where key in ('phone:' || p_phone, 'user:' || p_target::text)
      and operation_id = p_operation and expires_at > now()) <> 2 then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended('phone-auth:' || p_phone,0));
  select case when phone_verified_at is not null then public.phone_auth_e164(phone::text) end
    into target_profile_phone from public.profiles where id = p_target for update;
  select case when phone_confirmed_at is not null then public.phone_auth_e164('+' || ltrim(phone,'+')) end
    into target_auth_phone from auth.users where id = p_target for update;
  if not found then return false; end if;
  if coalesce(target_profile_phone,target_auth_phone) is distinct from p_phone
    or (target_profile_phone is not null and target_profile_phone <> p_phone)
    or (target_auth_phone is not null and target_auth_phone <> p_phone) then return false; end if;
  select phone_e164 into target_contact_phone from public.sms_phone_contacts
    where user_id = p_target and phone_e164 <> p_phone limit 1;
  if found then return false; end if;
  if exists(select 1 from unnest(public.phone_auth_owners(p_phone)) owner_id where owner_id <> p_target) then return false; end if;

  -- Existing sessions are retained so the person can verify the replacement;
  -- the portal gate refuses access until that new phone is verified.
  perform set_config('proplane.phone_auth_binding','yes',true);
  update public.profiles set phone = null, phone_verified_at = null, updated_at = now() where id = p_target;
  delete from auth.identities where user_id = p_target and provider = 'phone';
  select coalesce(jsonb_agg(distinct provider),'[]'::jsonb) into remaining_providers
    from auth.identities where user_id = p_target;
  update auth.users set phone = null, phone_confirmed_at = null,
    phone_change = '', phone_change_token = '', phone_change_sent_at = null,
    raw_app_meta_data = jsonb_set(
      case when raw_app_meta_data->>'provider' = 'phone'
        then (coalesce(raw_app_meta_data,'{}'::jsonb) - 'provider') ||
          case when jsonb_array_length(remaining_providers) > 0 then jsonb_build_object('provider',remaining_providers->>0) else '{}'::jsonb end
        else coalesce(raw_app_meta_data,'{}'::jsonb) end,
      '{providers}',remaining_providers),
    updated_at = now() where id = p_target;
  update public.sms_phone_contacts set user_id = null where user_id = p_target;
  -- Consumed old-number proofs and not-yet-entered codes must never restore the
  -- released identity. Include anonymous sign-in challenges to the old phone.
  update public.phone_otp_challenges set consumed_at = now(), completed_at = now(), verified_at = null
    where auth_user_id = p_target or phone_e164 = p_phone;
  insert into public.audit_log(actor_user_id, landlord_id, action, input_summary, result_summary, dedupe_key)
    values(p_actor,p_actor,'phone_auth_reset',jsonb_build_object('targetUserId',p_target,'workspaceId',p_workspace),
      jsonb_build_object('phoneReleased',true),'phone-auth-reset:' || p_operation::text);
  perform set_config('proplane.phone_auth_binding','',true);
  return true;
end $$;

revoke all on function public.phone_auth_reset(uuid,uuid,uuid,text,uuid) from public, anon, authenticated;
grant execute on function public.phone_auth_reset(uuid,uuid,uuid,text,uuid) to service_role;
