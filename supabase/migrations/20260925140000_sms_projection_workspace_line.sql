-- Correct owner proof for a work-number row held by a co-manager but homed in the owner workspace.
-- A number shared into another workspace does not create a second conversation owner.
create or replace function public.project_sms_conversation_event(p_event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner uuid := nullif(p_event->>'ownerManagerUserId','')::uuid;
  v_role text := p_event->>'counterpartyRole';
  v_line uuid := nullif(p_event->>'workLineId','')::uuid;
  v_identity text := p_event->>'identityKey';
  v_kind text := p_event->>'identityKind';
  v_phone text := nullif(p_event->>'counterpartyPhone','');
  v_from text := nullif(p_event->>'fromPhone','');
  v_to text := nullif(p_event->>'toPhone','');
  v_direction text := p_event->>'direction';
  v_body text := p_event->>'body';
  v_occurred timestamptz := (p_event->>'occurredAt')::timestamptz;
  v_namespace text := p_event->>'sourceNamespace';
  v_source_id text := p_event->>'sourceEventId';
  v_conversation public.sms_projection_conversations%rowtype;
  v_turn_id uuid;
  v_inserted boolean := false;
  v_alias_kind text;
  v_alias_value text;
  v_existing uuid;
  v_line_matches integer;
  v_line_phone text;
  v_prior public.sms_projection_turns%rowtype;
  v_prior_conversation public.sms_projection_conversations%rowtype;
  v_target public.sms_projection_conversations%rowtype;
begin
  if v_owner is null or v_line is null or v_role is null or v_role not in ('prospect','resident','applicant','vendor','manager','admin','unknown')
     or v_identity is null or v_identity = '' or v_kind is null or v_kind not in ('phone','user','unresolved')
     or v_direction is null or v_direction not in ('inbound','outbound') or v_body is null or v_occurred is null
     or v_namespace is null or v_namespace = '' or v_source_id is null or v_source_id = '' then
    raise exception 'invalid sms projection event' using errcode = '22023';
  end if;
  if v_role='unknown' and (v_kind <> 'unresolved' or v_identity <> 'unresolved:' || v_source_id) then
    raise exception 'unknown SMS identity must be exact event scoped' using errcode='22023';
  end if;
  select count(*),min(n.phone_number) into v_line_matches,v_line_phone from public.manager_sms_numbers n
    where n.id = v_line and (n.manager_user_id = v_owner or exists (select 1 from public.portal_workspaces w where w.id=n.workspace_id and w.owner_user_id=v_owner)) and n.provision_state in ('active','released')
      and coalesce(n.provisioned_at,n.requested_at) <= v_occurred
      and (n.released_at is null or v_occurred <= n.released_at)
      and (n.phone_number = v_from or n.phone_number = v_to);
  if v_line_matches <> 1 then
    raise exception 'sms projection work line is not active for owner and event pair' using errcode = '42501';
  end if;

  -- An exact original provider event may resolve an isolated unknown routing
  -- placeholder. The event bytes and original wire pair must match exactly;
  -- names, current directory data, and phone-only aliases cannot promote it.
  select * into v_prior from public.sms_projection_turns
    where owner_manager_user_id=v_owner and source_namespace=v_namespace and source_event_id=v_source_id;
  if found then
    select * into v_prior_conversation from public.sms_projection_conversations where id=v_prior.conversation_id for update;
    if v_prior_conversation.owner_manager_user_id=v_owner and v_prior_conversation.work_line_id=v_line
       and v_prior_conversation.counterparty_role=v_role and v_prior_conversation.identity_key=v_identity
       and v_prior_conversation.identity_kind=v_kind and v_prior.body=v_body
       and v_prior.direction=v_direction and v_prior.occurred_at=v_occurred
       and v_prior.from_phone is not distinct from v_from and v_prior.to_phone is not distinct from v_to then
      -- A replay cannot rewrite summary metadata, names, aliases, or chronology.
      return jsonb_build_object('conversationId',v_prior_conversation.id,'turnId',v_prior.id,'inserted',false,'eventCount',v_prior_conversation.event_count);
    end if;
    if v_prior_conversation.owner_manager_user_id=v_owner
       and v_prior_conversation.work_line_id=v_line
       and ((v_prior_conversation.counterparty_role='unknown' and v_prior_conversation.identity_kind='unresolved')
         or (v_prior_conversation.counterparty_role=v_role and v_prior_conversation.identity_kind in ('phone','unresolved') and v_kind='user'))
       and v_prior.body=v_body and v_prior.direction=v_direction and v_prior.occurred_at=v_occurred
       and v_prior.from_phone is not distinct from v_from and v_prior.to_phone is not distinct from v_to
       and (v_role <> 'unknown' or v_kind <> 'unresolved' or v_identity <> v_prior_conversation.identity_key) then
      select * into v_target from public.sms_projection_conversations
        where owner_manager_user_id=v_owner and counterparty_role=v_role and work_line_id=v_line and identity_key=v_identity
          and id<>v_prior_conversation.id and merged_into_id is null for update;
      if found then
        -- A source SID proves this single event, never a fuzzy whole-thread
        -- merge. Unknown placeholders are required to hold only that SID.
        if v_prior_conversation.event_count<>1 or
           (select count(*) from public.sms_projection_turns where conversation_id=v_prior_conversation.id)<>1 then
          raise exception 'unknown SMS placeholder contains more than the proven event' using errcode='23505';
        end if;
        update public.sms_projection_turns set conversation_id=v_target.id where id=v_prior.id;
        update public.sms_projection_conversations c set
          event_count=event_count+1,
          last_body=case when (c.last_event_at is null or (v_occurred,v_prior.id)>(c.last_event_at,c.last_event_id)) then v_body else c.last_body end,
          last_direction=case when (c.last_event_at is null or (v_occurred,v_prior.id)>(c.last_event_at,c.last_event_id)) then v_direction else c.last_direction end,
          last_event_at=greatest(coalesce(c.last_event_at,v_occurred),v_occurred),
          last_event_id=case when c.last_event_at is null or (v_occurred,v_prior.id)>(c.last_event_at,c.last_event_id) then v_prior.id else c.last_event_id end,
          last_inbound_at=case when v_direction='inbound' and (c.last_inbound_at is null or (v_occurred,v_prior.id)>(c.last_inbound_at,c.last_inbound_event_id)) then v_occurred else c.last_inbound_at end,
          last_inbound_event_id=case when v_direction='inbound' and (c.last_inbound_at is null or (v_occurred,v_prior.id)>(c.last_inbound_at,c.last_inbound_event_id)) then v_prior.id else c.last_inbound_event_id end,
          updated_at=now()
          where c.id=v_target.id returning * into v_target;
        insert into public.sms_projection_view_state(viewer_user_id,conversation_id,is_archived,read_through_at,read_through_event_id)
          select viewer_user_id,v_target.id,is_archived,read_through_at,read_through_event_id
          from public.sms_projection_view_state where conversation_id=v_prior_conversation.id
          on conflict(viewer_user_id,conversation_id) do update set
            is_archived=public.sms_projection_view_state.is_archived or excluded.is_archived,
            read_through_at=case when excluded.read_through_at is not null and
              (public.sms_projection_view_state.read_through_at is null or
               (excluded.read_through_at,excluded.read_through_event_id)>(public.sms_projection_view_state.read_through_at,public.sms_projection_view_state.read_through_event_id))
              then excluded.read_through_at else public.sms_projection_view_state.read_through_at end,
            read_through_event_id=case when excluded.read_through_at is not null and
              (public.sms_projection_view_state.read_through_at is null or
               (excluded.read_through_at,excluded.read_through_event_id)>(public.sms_projection_view_state.read_through_at,public.sms_projection_view_state.read_through_event_id))
              then excluded.read_through_event_id else public.sms_projection_view_state.read_through_event_id end,
            version=public.sms_projection_view_state.version+1,updated_at=now();
        update public.sms_projection_conversations set merged_into_id=v_target.id,event_count=0,updated_at=now() where id=v_prior_conversation.id;
        v_conversation := v_target;
      else
      update public.sms_projection_conversations set
        counterparty_role=v_role, identity_key=v_identity, identity_kind=v_kind,
        counterparty_user_id=nullif(p_event->>'counterpartyUserId','')::uuid,
        counterparty_phone=coalesce(v_phone,counterparty_phone),
        updated_at=now()
        where id=v_prior_conversation.id;
      update public.sms_projection_aliases set counterparty_role=v_role
        where conversation_id=v_prior_conversation.id and counterparty_role='unknown';
      select * into v_conversation from public.sms_projection_conversations where id=v_prior_conversation.id;
      end if;
      foreach v_alias_kind in array array['legacy_key','legacy_thread'] loop
        v_alias_value := case when v_alias_kind='legacy_key' then nullif(p_event->>'legacyConversationKey','') else nullif(p_event->>'legacyThreadId','') end;
        if v_alias_value is not null then
          insert into public.sms_projection_aliases(owner_manager_user_id,counterparty_role,work_line_id,alias_kind,alias_value,conversation_id,source_owner_id)
          values(v_owner,v_role,v_line,v_alias_kind,v_alias_value,v_conversation.id,v_owner)
          on conflict(owner_manager_user_id,counterparty_role,work_line_id,alias_kind,alias_value) do nothing;
          select conversation_id into v_existing from public.sms_projection_aliases
            where owner_manager_user_id=v_owner and counterparty_role=v_role and work_line_id=v_line and alias_kind=v_alias_kind and alias_value=v_alias_value;
          if v_existing is distinct from v_conversation.id then raise exception 'sms alias collision' using errcode='23505'; end if;
        end if;
      end loop;
      return jsonb_build_object('conversationId',v_conversation.id,'turnId',v_prior.id,'inserted',false,'eventCount',v_conversation.event_count);
    end if;
  end if;

  insert into public.sms_projection_conversations(
    owner_manager_user_id,counterparty_role,work_line_id,identity_key,identity_kind,
    counterparty_user_id,counterparty_phone,work_line_phone,legacy_conversation_key,metadata
  ) values (
    v_owner,v_role,v_line,v_identity,v_kind,
    nullif(p_event->>'counterpartyUserId','')::uuid,v_phone,v_line_phone,
    nullif(p_event->>'legacyConversationKey',''),
    case when jsonb_typeof(p_event->'metadata') = 'object' then p_event->'metadata' else '{}'::jsonb end
  ) on conflict(owner_manager_user_id,counterparty_role,work_line_id,identity_key)
    do update set
      counterparty_user_id = coalesce(public.sms_projection_conversations.counterparty_user_id, excluded.counterparty_user_id),
      counterparty_phone = coalesce(excluded.counterparty_phone, public.sms_projection_conversations.counterparty_phone),
      legacy_conversation_key = coalesce(public.sms_projection_conversations.legacy_conversation_key, excluded.legacy_conversation_key),
      metadata = public.sms_projection_conversations.metadata || excluded.metadata,
      updated_at = now()
  returning * into v_conversation;

  insert into public.sms_projection_turns(owner_manager_user_id,conversation_id,source_namespace,source_event_id,direction,body,occurred_at,from_phone,to_phone,source_ref)
  values(v_owner,v_conversation.id,v_namespace,v_source_id,v_direction,v_body,v_occurred,v_from,v_to,
    case when jsonb_typeof(p_event->'sourceRef') = 'object' then p_event->'sourceRef' else '{}'::jsonb end)
  on conflict(owner_manager_user_id,source_namespace,source_event_id) do nothing returning id into v_turn_id;
  v_inserted := v_turn_id is not null;
  if not v_inserted then
    select id,conversation_id into v_turn_id,v_existing from public.sms_projection_turns
      where owner_manager_user_id=v_owner and source_namespace=v_namespace and source_event_id=v_source_id;
    select * into v_prior from public.sms_projection_turns where id=v_turn_id;
    if v_existing is distinct from v_conversation.id or v_prior.body is distinct from v_body
       or v_prior.direction is distinct from v_direction or v_prior.occurred_at is distinct from v_occurred
       or v_prior.from_phone is distinct from v_from or v_prior.to_phone is distinct from v_to then
      raise exception 'sms source event already belongs to another conversation' using errcode = '23505';
    end if;
  else
    update public.sms_projection_conversations c set
      event_count = event_count + 1,
      last_body = case when (c.last_event_at is null or (v_occurred,v_turn_id) > (c.last_event_at,c.last_event_id)) then v_body else c.last_body end,
      last_direction = case when (c.last_event_at is null or (v_occurred,v_turn_id) > (c.last_event_at,c.last_event_id)) then v_direction else c.last_direction end,
      last_event_at = greatest(coalesce(c.last_event_at,v_occurred),v_occurred),
      last_event_id = case when c.last_event_at is null or (v_occurred,v_turn_id) > (c.last_event_at,c.last_event_id) then v_turn_id else c.last_event_id end,
      last_inbound_at = case when v_direction='inbound' and (c.last_inbound_at is null or (v_occurred,v_turn_id) > (c.last_inbound_at,c.last_inbound_event_id)) then v_occurred else c.last_inbound_at end,
      last_inbound_event_id = case when v_direction='inbound' and (c.last_inbound_at is null or (v_occurred,v_turn_id) > (c.last_inbound_at,c.last_inbound_event_id)) then v_turn_id else c.last_inbound_event_id end,
      updated_at = now()
    where c.id=v_conversation.id returning * into v_conversation;
  end if;

  foreach v_alias_kind in array array['legacy_key','legacy_thread'] loop
    v_alias_value := case when v_alias_kind='legacy_key' then nullif(p_event->>'legacyConversationKey','') else nullif(p_event->>'legacyThreadId','') end;
    if v_alias_value is not null then
      insert into public.sms_projection_aliases(owner_manager_user_id,counterparty_role,work_line_id,alias_kind,alias_value,conversation_id,source_owner_id)
      values(v_owner,v_role,v_line,v_alias_kind,v_alias_value,v_conversation.id,v_owner)
      on conflict(owner_manager_user_id,counterparty_role,work_line_id,alias_kind,alias_value) do nothing;
      select conversation_id into v_existing from public.sms_projection_aliases
        where owner_manager_user_id=v_owner and counterparty_role=v_role and work_line_id=v_line and alias_kind=v_alias_kind and alias_value=v_alias_value;
      if v_existing is distinct from v_conversation.id then raise exception 'sms alias collision' using errcode='23505'; end if;
    end if;
  end loop;
  return jsonb_build_object('conversationId',v_conversation.id,'turnId',v_turn_id,'inserted',v_inserted,'eventCount',v_conversation.event_count);
end;
$$;
revoke all on function public.project_sms_conversation_event(jsonb) from public, anon, authenticated;
grant execute on function public.project_sms_conversation_event(jsonb) to service_role;
