-- Give authenticated SMS tests the same lease-fenced durable tour-context
-- merge as live phone conversations. One identity-aware core keeps correction,
-- terminal-state, and lease behavior identical across both transports.

create or replace function public.merge_prospect_sms_tour_context_identity_core(
  p_manager_user_id uuid, p_conversation_key text, p_trusted_phone_e164 text,
  p_test_actor_user_id uuid, p_test_session_id uuid, p_identity_kind text,
  p_property_id text, p_room_id text, p_contact_name text, p_contact_email text,
  p_constraints jsonb, p_burst_id uuid, p_burst_revision integer, p_worker_id text
) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_property_id text := nullif(trim(p_property_id),'');
  v_state public.prospect_tour_scheduling_state;
  v_active_count integer;
begin
  if p_manager_user_id is null or coalesce(trim(p_conversation_key),'')=''
    or not (
      (p_identity_kind='live_phone' and coalesce(trim(p_trusted_phone_e164),'')<>''
        and p_test_actor_user_id is null and p_test_session_id is null)
      or
      (p_identity_kind='authenticated_test' and p_trusted_phone_e164 is null
        and p_test_actor_user_id is not null and p_test_session_id is not null)
    ) then
    return jsonb_build_object('ok',false,'reason','invalid_identity');
  end if;

  perform 1 from public.prospect_sms_bursts
    where id=p_burst_id and revision=p_burst_revision and manager_user_id=p_manager_user_id
      and identity_kind=p_identity_kind and status='generating'
      and lease_owner=p_worker_id and lease_expires_at>now()
      and (
        (p_identity_kind='live_phone' and counterparty_phone_e164=p_trusted_phone_e164
          and test_actor_user_id is null and test_session_id is null)
        or
        (p_identity_kind='authenticated_test' and counterparty_phone_e164 is null
          and test_actor_user_id=p_test_actor_user_id and test_session_id=p_test_session_id)
      )
    for update;
  if not found then return jsonb_build_object('ok',false,'reason','stale_worker'); end if;

  if p_identity_kind='authenticated_test' then
    perform 1 from public.agent_sessions
      where id=p_test_session_id and user_id=p_test_actor_user_id
        and test_actor_user_id=p_test_actor_user_id and landlord_id=p_manager_user_id
        and sms_test_manager_user_id=p_manager_user_id and sms_test_mode='prospect'
        and status='active';
    if not found then return jsonb_build_object('ok',false,'reason','invalid_test_session'); end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'proplane:prospect-tour-context:' || p_manager_user_id::text || ':' || p_conversation_key,0
  ));

  if v_property_id is null then
    select count(*),min(property_id) into v_active_count,v_property_id
      from public.prospect_tour_scheduling_state
      where manager_user_id=p_manager_user_id and conversation_key=p_conversation_key
        and identity_kind=p_identity_kind
        and (
          (p_identity_kind='live_phone' and trusted_phone_e164=p_trusted_phone_e164
            and test_actor_user_id is null and test_session_id is null)
          or
          (p_identity_kind='authenticated_test' and trusted_phone_e164 is null
            and test_actor_user_id=p_test_actor_user_id and test_session_id=p_test_session_id)
        )
        and status in ('collecting','offered');
    if v_active_count<>1 then return jsonb_build_object('ok',false,'reason','ambiguous_property'); end if;
  end if;

  select * into v_state from public.prospect_tour_scheduling_state
    where manager_user_id=p_manager_user_id and conversation_key=p_conversation_key
      and property_id=v_property_id and identity_kind=p_identity_kind
      and (
        (p_identity_kind='live_phone' and trusted_phone_e164=p_trusted_phone_e164
          and test_actor_user_id is null and test_session_id is null)
        or
        (p_identity_kind='authenticated_test' and trusted_phone_e164 is null
          and test_actor_user_id=p_test_actor_user_id and test_session_id=p_test_session_id)
      )
    for update;
  if found and v_state.status not in ('collecting','offered') then
    return jsonb_build_object('ok',false,'reason','terminal_scheduling_state');
  end if;

  update public.prospect_tour_scheduling_state set
    status='cancelled',selected_offer=null,updated_at=now()
  where manager_user_id=p_manager_user_id and conversation_key=p_conversation_key
    and identity_kind=p_identity_kind and property_id<>v_property_id
    and status in ('collecting','offered')
    and (
      (p_identity_kind='live_phone' and trusted_phone_e164=p_trusted_phone_e164
        and test_actor_user_id is null and test_session_id is null)
      or
      (p_identity_kind='authenticated_test' and trusted_phone_e164 is null
        and test_actor_user_id=p_test_actor_user_id and test_session_id=p_test_session_id)
    );

  insert into public.prospect_tour_scheduling_state(
    manager_user_id,conversation_key,property_id,room_id,contact_name,contact_email,
    trusted_phone_e164,test_actor_user_id,test_session_id,identity_kind,
    selected_offer,status,last_inbound_at
  ) values(
    p_manager_user_id,p_conversation_key,v_property_id,nullif(trim(p_room_id),''),
    nullif(trim(p_contact_name),''),nullif(trim(p_contact_email),''),
    nullif(trim(p_trusted_phone_e164),''),p_test_actor_user_id,p_test_session_id,p_identity_kind,
    case when p_constraints is null then null else jsonb_build_object('constraints',p_constraints) end,
    'collecting',now()
  ) on conflict(manager_user_id,conversation_key,property_id) do update set
    room_id=coalesce(excluded.room_id,public.prospect_tour_scheduling_state.room_id),
    contact_name=coalesce(excluded.contact_name,public.prospect_tour_scheduling_state.contact_name),
    contact_email=coalesce(excluded.contact_email,public.prospect_tour_scheduling_state.contact_email),
    trusted_phone_e164=excluded.trusted_phone_e164,
    test_actor_user_id=excluded.test_actor_user_id,
    test_session_id=excluded.test_session_id,
    identity_kind=excluded.identity_kind,
    -- Date/time corrections clear the exact offered slot. Contact-only follow-up
    -- retains it so a later standalone YES can still authorize that offer.
    selected_offer=case when p_constraints is null
      then public.prospect_tour_scheduling_state.selected_offer
      else jsonb_build_object('constraints',p_constraints) end,
    status=case when p_constraints is null
      then public.prospect_tour_scheduling_state.status else 'collecting' end,
    last_inbound_at=now(),updated_at=now()
  where public.prospect_tour_scheduling_state.status in ('collecting','offered')
    and public.prospect_tour_scheduling_state.identity_kind=p_identity_kind
    and (
      (p_identity_kind='live_phone'
        and public.prospect_tour_scheduling_state.trusted_phone_e164=p_trusted_phone_e164
        and public.prospect_tour_scheduling_state.test_actor_user_id is null
        and public.prospect_tour_scheduling_state.test_session_id is null)
      or
      (p_identity_kind='authenticated_test'
        and public.prospect_tour_scheduling_state.trusted_phone_e164 is null
        and public.prospect_tour_scheduling_state.test_actor_user_id=p_test_actor_user_id
        and public.prospect_tour_scheduling_state.test_session_id=p_test_session_id)
    )
  returning * into v_state;
  if not found then return jsonb_build_object('ok',false,'reason','terminal_scheduling_state'); end if;
  return jsonb_build_object('ok',true,'stateId',v_state.id);
end; $$;

create or replace function public.merge_prospect_sms_tour_context(
  p_manager_user_id uuid,p_conversation_key text,p_trusted_phone_e164 text,
  p_property_id text,p_room_id text,p_contact_name text,p_contact_email text,
  p_constraints jsonb,p_burst_id uuid,p_burst_revision integer,p_worker_id text
) returns jsonb
language sql security definer set search_path=public,pg_temp as $$
  select public.merge_prospect_sms_tour_context_identity_core(
    p_manager_user_id,p_conversation_key,p_trusted_phone_e164,null,null,'live_phone',
    p_property_id,p_room_id,p_contact_name,p_contact_email,p_constraints,
    p_burst_id,p_burst_revision,p_worker_id
  );
$$;

create or replace function public.merge_authenticated_sms_test_tour_context(
  p_manager_user_id uuid,p_conversation_key text,p_test_actor_user_id uuid,p_test_session_id uuid,
  p_property_id text,p_room_id text,p_contact_name text,p_contact_email text,
  p_constraints jsonb,p_burst_id uuid,p_burst_revision integer,p_worker_id text
) returns jsonb
language sql security definer set search_path=public,pg_temp as $$
  select public.merge_prospect_sms_tour_context_identity_core(
    p_manager_user_id,p_conversation_key,null,p_test_actor_user_id,p_test_session_id,'authenticated_test',
    p_property_id,p_room_id,p_contact_name,p_contact_email,p_constraints,
    p_burst_id,p_burst_revision,p_worker_id
  );
$$;

revoke execute on function public.merge_prospect_sms_tour_context_identity_core(
  uuid,text,text,uuid,uuid,text,text,text,text,text,jsonb,uuid,integer,text
) from public,anon,authenticated;
revoke execute on function public.merge_prospect_sms_tour_context(
  uuid,text,text,text,text,text,text,jsonb,uuid,integer,text
) from public,anon,authenticated;
revoke execute on function public.merge_authenticated_sms_test_tour_context(
  uuid,text,uuid,uuid,text,text,text,text,jsonb,uuid,integer,text
) from public,anon,authenticated;
grant execute on function public.merge_prospect_sms_tour_context(
  uuid,text,text,text,text,text,text,jsonb,uuid,integer,text
) to service_role;
grant execute on function public.merge_authenticated_sms_test_tour_context(
  uuid,text,uuid,uuid,text,text,text,text,jsonb,uuid,integer,text
) to service_role;
