-- Additive correction 2: linearize SMS projection writes/deletes per owner,
-- and require full event plus canonical identity proof for historical replay.
-- Applied migrations 130-170 remain unchanged.

create or replace function public.recompute_sms_projection_summary(p_conversation uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_last public.sms_projection_turns%rowtype; v_inbound public.sms_projection_turns%rowtype; v_count bigint;
begin
  select count(*) into v_count from public.sms_projection_turns where conversation_id=p_conversation;
  select * into v_last from public.sms_projection_turns where conversation_id=p_conversation
    order by occurred_at desc,id desc limit 1;
  select * into v_inbound from public.sms_projection_turns where conversation_id=p_conversation and direction='inbound'
    order by occurred_at desc,id desc limit 1;
  update public.sms_projection_conversations set event_count=v_count,
    last_body=coalesce(v_last.body,''),last_direction=v_last.direction,
    last_event_at=v_last.occurred_at,last_event_id=v_last.id,
    last_inbound_at=v_inbound.occurred_at,last_inbound_event_id=v_inbound.id,updated_at=now()
    where id=p_conversation;
end;
$$;
revoke all on function public.recompute_sms_projection_summary(uuid) from public,anon,authenticated;
grant execute on function public.recompute_sms_projection_summary(uuid) to service_role;

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
  perform pg_advisory_xact_lock(hashtextextended('sms-projection-owner:'||v_owner::text,0));
  if exists(select 1 from public.sms_projection_deleted_events d
      where d.owner_manager_user_id=v_owner and
       ((d.source_namespace=v_namespace and d.source_event_id=v_source_id)
        or (v_source_id like 'SM%' and d.provider_sid=v_source_id))) then
    return jsonb_build_object('skipped','deleted');
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
  if v_namespace like 'twilio:%' and v_source_id like 'SM%' then
    perform pg_advisory_xact_lock(hashtextextended('sms-provider:'||v_owner::text||':'||v_source_id,0));
    select * into v_prior from public.sms_projection_turns
      where owner_manager_user_id=v_owner and provider_sid=v_source_id;
    if found and v_prior.source_namespace like 'historical:%' then
      select * into v_prior_conversation from public.sms_projection_conversations
        where id=v_prior.conversation_id and owner_manager_user_id=v_owner for update;
      if v_prior.body is distinct from v_body or v_prior.direction is distinct from v_direction
         or v_prior.occurred_at is distinct from v_occurred
         or v_prior.from_phone is distinct from v_from or v_prior.to_phone is distinct from v_to then
        raise exception 'historical provider event conflicts with live replay' using errcode='23505';
      end if;
      if v_prior_conversation.counterparty_role=v_role and v_prior_conversation.work_line_id=v_line
         and v_prior_conversation.identity_kind=v_kind and v_prior_conversation.identity_key=v_identity
         and v_prior_conversation.counterparty_user_id is not distinct from nullif(p_event->>'counterpartyUserId','')::uuid
         and v_prior_conversation.counterparty_phone is not distinct from v_phone then
        return jsonb_build_object('conversationId',v_prior.conversation_id,'turnId',v_prior.id,'inserted',false,'eventCount',v_prior_conversation.event_count);
      end if;
      if not ((v_prior_conversation.counterparty_role=v_role and v_prior_conversation.identity_kind=v_kind
              and v_prior_conversation.identity_key=v_identity
              and v_prior_conversation.counterparty_user_id is not distinct from nullif(p_event->>'counterpartyUserId','')::uuid)
          or (v_prior_conversation.identity_kind='unresolved' and v_prior_conversation.counterparty_role in ('unknown',v_role)
              and v_kind in ('user','phone') and v_role<>'unknown')
          or (v_prior_conversation.counterparty_role=v_role and v_prior_conversation.identity_kind='phone'
              and v_kind='user' and v_prior_conversation.counterparty_phone is not distinct from v_phone)) then
        raise exception 'historical provider identity conflicts with live replay' using errcode='23505';
      end if;
      -- Exact wire/time proof binds only this original event. Preserve any
      -- other synthetic turns and their aliases under their old identity.
      select * into v_target from public.sms_projection_conversations
        where owner_manager_user_id=v_owner and counterparty_role=v_role and work_line_id=v_line
          and identity_key=v_identity and merged_into_id is null for update;
      if not found then
        insert into public.sms_projection_conversations(owner_manager_user_id,counterparty_role,work_line_id,identity_key,identity_kind,
          counterparty_user_id,counterparty_phone,work_line_phone,legacy_conversation_key,metadata)
        values(v_owner,v_role,v_line,v_identity,v_kind,nullif(p_event->>'counterpartyUserId','')::uuid,v_phone,v_line_phone,
          nullif(p_event->>'legacyConversationKey',''),
          (v_prior_conversation.metadata - 'historical' - 'sendDisabled') ||
            case when jsonb_typeof(p_event->'metadata')='object' then p_event->'metadata' else '{}'::jsonb end)
        on conflict(owner_manager_user_id,counterparty_role,work_line_id,identity_key) do update set updated_at=now()
        returning * into v_target;
      end if;
      update public.sms_projection_turns set conversation_id=v_target.id,source_namespace=v_namespace,
        source_event_id=v_source_id,source_ref=coalesce(source_ref,'{}'::jsonb) ||
          case when jsonb_typeof(p_event->'sourceRef')='object' then p_event->'sourceRef' else '{}'::jsonb end ||
          jsonb_build_object('historicalIdentity',jsonb_build_object(
            'counterpartyRole',v_prior_conversation.counterparty_role,
            'workLineId',v_prior_conversation.work_line_id,
            'identityKind',v_prior_conversation.identity_kind,
            'identityKey',v_prior_conversation.identity_key,
            'counterpartyUserId',v_prior_conversation.counterparty_user_id,
            'counterpartyPhone',v_prior_conversation.counterparty_phone))
        where id=v_prior.id;
      perform public.recompute_sms_projection_summary(v_prior_conversation.id);
      perform public.recompute_sms_projection_summary(v_target.id);
      select * into v_target from public.sms_projection_conversations where id=v_target.id;
      if not exists(select 1 from public.sms_projection_turns where conversation_id=v_prior_conversation.id) then
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
        update public.sms_projection_conversations set merged_into_id=v_target.id,event_count=0,updated_at=now()
          where id=v_prior_conversation.id;
      end if;
      return jsonb_build_object('conversationId',v_target.id,'turnId',v_prior.id,'inserted',false,'eventCount',v_target.event_count);
    end if;
  end if;
  select * into v_prior from public.sms_projection_turns
    where owner_manager_user_id=v_owner and source_namespace=v_namespace and source_event_id=v_source_id;
  if found then
    select * into v_prior_conversation from public.sms_projection_conversations where id=v_prior.conversation_id for update;
    if v_prior_conversation.owner_manager_user_id=v_owner and v_prior_conversation.work_line_id=v_line
       and v_prior_conversation.counterparty_role=v_role and v_prior_conversation.identity_key=v_identity
       and v_prior_conversation.identity_kind=v_kind
       and v_prior_conversation.counterparty_user_id is not distinct from nullif(p_event->>'counterpartyUserId','')::uuid
       and v_prior_conversation.counterparty_phone is not distinct from v_phone and v_prior.body=v_body
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
      if not found and v_prior_conversation.event_count>1 then
        insert into public.sms_projection_conversations(owner_manager_user_id,counterparty_role,work_line_id,identity_key,identity_kind,
          counterparty_user_id,counterparty_phone,work_line_phone,legacy_conversation_key,metadata)
        values(v_owner,v_role,v_line,v_identity,v_kind,nullif(p_event->>'counterpartyUserId','')::uuid,v_phone,
          v_prior_conversation.work_line_phone,nullif(p_event->>'legacyConversationKey',''),v_prior_conversation.metadata)
        on conflict(owner_manager_user_id,counterparty_role,work_line_id,identity_key) do update set updated_at=now()
        returning * into v_target;
      end if;
      if found then
        -- Move only the proven event. A phone summary may hold other originals
        -- that remain under phone identity until they each acquire evidence.
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
        if v_prior_conversation.event_count=1 then
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
        else
          perform public.recompute_sms_projection_summary(v_prior_conversation.id);
        end if;
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
        if v_alias_value is not null and v_role <> 'unknown' and not exists(
          select 1 from public.sms_projection_ambiguous_aliases a where a.owner_manager_user_id=v_owner
            and a.counterparty_role=v_role and a.work_line_id=v_line and a.alias_kind=v_alias_kind and a.alias_value=v_alias_value) then
          insert into public.sms_projection_aliases(owner_manager_user_id,counterparty_role,work_line_id,alias_kind,alias_value,conversation_id,source_owner_id)
          values(v_owner,v_role,v_line,v_alias_kind,v_alias_value,v_conversation.id,v_owner)
          on conflict(owner_manager_user_id,counterparty_role,work_line_id,alias_kind,alias_value) do nothing;
          select conversation_id into v_existing from public.sms_projection_aliases
            where owner_manager_user_id=v_owner and counterparty_role=v_role and work_line_id=v_line and alias_kind=v_alias_kind and alias_value=v_alias_value;
          if v_existing is distinct from v_conversation.id then
            insert into public.sms_projection_ambiguous_aliases(owner_manager_user_id,counterparty_role,work_line_id,alias_kind,alias_value)
              values(v_owner,v_role,v_line,v_alias_kind,v_alias_value) on conflict do nothing;
            delete from public.sms_projection_aliases where owner_manager_user_id=v_owner and counterparty_role=v_role
              and work_line_id=v_line and alias_kind=v_alias_kind and alias_value=v_alias_value;
          end if;
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

  insert into public.sms_projection_turns(owner_manager_user_id,conversation_id,source_namespace,source_event_id,provider_sid,direction,body,occurred_at,from_phone,to_phone,source_ref)
  values(v_owner,v_conversation.id,v_namespace,v_source_id,case when v_namespace like 'twilio:%' and v_source_id like 'SM%' then v_source_id else null end,v_direction,v_body,v_occurred,v_from,v_to,
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
    if v_alias_value is not null and v_role <> 'unknown' and not exists(
          select 1 from public.sms_projection_ambiguous_aliases a where a.owner_manager_user_id=v_owner
            and a.counterparty_role=v_role and a.work_line_id=v_line and a.alias_kind=v_alias_kind and a.alias_value=v_alias_value) then
      insert into public.sms_projection_aliases(owner_manager_user_id,counterparty_role,work_line_id,alias_kind,alias_value,conversation_id,source_owner_id)
      values(v_owner,v_role,v_line,v_alias_kind,v_alias_value,v_conversation.id,v_owner)
      on conflict(owner_manager_user_id,counterparty_role,work_line_id,alias_kind,alias_value) do nothing;
      select conversation_id into v_existing from public.sms_projection_aliases
        where owner_manager_user_id=v_owner and counterparty_role=v_role and work_line_id=v_line and alias_kind=v_alias_kind and alias_value=v_alias_value;
      if v_existing is distinct from v_conversation.id then
            insert into public.sms_projection_ambiguous_aliases(owner_manager_user_id,counterparty_role,work_line_id,alias_kind,alias_value)
              values(v_owner,v_role,v_line,v_alias_kind,v_alias_value) on conflict do nothing;
            delete from public.sms_projection_aliases where owner_manager_user_id=v_owner and counterparty_role=v_role
              and work_line_id=v_line and alias_kind=v_alias_kind and alias_value=v_alias_value;
          end if;
    end if;
  end loop;
  return jsonb_build_object('conversationId',v_conversation.id,'turnId',v_turn_id,'inserted',v_inserted,'eventCount',v_conversation.event_count);
end;
$$;
revoke all on function public.project_sms_conversation_event(jsonb) from public,anon,authenticated;
grant execute on function public.project_sms_conversation_event(jsonb) to service_role;

create or replace function public.import_sms_projection_historical_event(p_source_table text, p_source_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner uuid;
  v_role text := 'unknown';
  v_user uuid;
  v_phone text;
  v_line_phone text;
  v_line_context text;
  v_line_id uuid;
  v_line_candidates uuid[];
  v_identity_kind text := 'unresolved';
  v_historical boolean := true;
  v_key text;
  v_legacy_key text;
  v_legacy_thread text;
  v_direction text;
  v_body text;
  v_at timestamptz;
  v_from text;
  v_to text;
  v_sid text;
  v_namespace text;
  v_source_id text;
  v_digest text;
  v_conversation public.sms_projection_conversations%rowtype;
  v_turn uuid;
  v_existing uuid;
  v_prior_body text;
  v_prior_at timestamptz;
  v_prior_direction text;
  v_prior_from text;
  v_prior_to text;
  v_existing_turn public.sms_projection_turns%rowtype;
  v_media_urls text[];
  v_alias_kind text;
  v_alias_value text;
begin
  if p_source_id is null or p_source_id = '' then
    raise exception 'invalid historical SMS source' using errcode='22023';
  end if;
  if p_source_table = 'prospect_sms_ingress' then
    select i.manager_user_id,'prospect',null::uuid,b.counterparty_phone_e164,
      coalesce(nullif(b.reply_from_number,''),'historical:'||i.channel),
      'work:'||coalesce(nullif(b.reply_from_number,''),'unplaced:'||i.channel),
      i.manager_user_id::text||':prospect:'||b.counterparty_phone_e164,
      i.manager_user_id::text||':prospect:'||b.counterparty_phone_e164,null::text,'inbound',i.body,i.received_at,
      b.counterparty_phone_e164,b.reply_from_number,i.source_message_id
    into v_owner,v_role,v_user,v_phone,v_line_phone,v_line_context,v_key,v_legacy_key,v_legacy_thread,
      v_direction,v_body,v_at,v_from,v_to,v_sid
    from public.prospect_sms_ingress i join public.prospect_sms_bursts b on b.id=i.burst_id
    where i.source_message_id=p_source_id and b.manager_user_id=i.manager_user_id;
  elsif p_source_table = 'inbound_sms_log' then
    select l.manager_user_id,l.counterparty_role,l.matched_sender_user_id,l.from_phone,l.to_phone,
      'work:'||l.to_phone,
      coalesce(nullif(l.conversation_key,''),'unresolved:inbound_sms_log:'||l.id::text),
      l.conversation_key,null::text,'inbound',l.body,l.created_at,l.from_phone,l.to_phone,l.message_sid
    into v_owner,v_role,v_user,v_phone,v_line_phone,v_line_context,v_key,v_legacy_key,v_legacy_thread,
      v_direction,v_body,v_at,v_from,v_to,v_sid
    from public.inbound_sms_log l where l.id=p_source_id::uuid;
    if v_sid is not null and exists(select 1 from public.prospect_sms_ingress i
      where i.source_message_id=v_sid and i.manager_user_id=v_owner) then
      return jsonb_build_object('skipped','prospect_ingress_preferred');
    end if;
  elsif p_source_table = 'manager_sms_messages' then
    select m.manager_user_id,m.counterparty_role,m.resident_user_id,m.resident_phone,
      case when m.direction='inbound' then m.to_phone else coalesce(nullif(m.from_phone,''),'historical:unplaced') end,
      case when m.source='relay' then 'relay-mirror:' else 'work:' end||
        case when m.direction='inbound' then m.to_phone else coalesce(nullif(m.from_phone,''),'unplaced') end,
      coalesce(nullif(m.conversation_key,''),'unresolved:manager_sms_messages:'||m.id::text),
      m.conversation_key,null::text,m.direction,m.body,m.created_at,m.from_phone,m.to_phone,m.message_sid
    into v_owner,v_role,v_user,v_phone,v_line_phone,v_line_context,v_key,v_legacy_key,v_legacy_thread,
      v_direction,v_body,v_at,v_from,v_to,v_sid
    from public.manager_sms_messages m where m.id=p_source_id::uuid;
    if v_sid is not null and (
      exists(select 1 from public.prospect_sms_ingress i where i.source_message_id=v_sid and i.manager_user_id=v_owner)
      or exists(select 1 from public.inbound_sms_log l where l.message_sid=v_sid and l.manager_user_id=v_owner)
    ) then
      return jsonb_build_object('skipped','earlier_original_preferred');
    end if;
  elsif p_source_table = 'sms_relay_messages' then
    select m.manager_user_id,'resident',t.counterparty_user_id,
      (select b.participant_phone from public.sms_relay_bindings b where b.thread_id=t.id and b.role='resident' order by b.created_at limit 1),
      n.phone_e164,'relay:'||t.proxy_number_id::text,
      'legacy-relay:'||t.id::text,
      m.manager_user_id::text||':resident:'||coalesce(t.counterparty_user_id::text,
        (select b.participant_phone from public.sms_relay_bindings b where b.thread_id=t.id and b.role='resident' order by b.created_at limit 1),''),
      'sms_relay_'||t.id::text,
      case when m.sender_role='manager' then 'outbound' else 'inbound' end,
      coalesce(m.body,''),m.created_at,null::text,null::text,m.twilio_sid
    into v_owner,v_role,v_user,v_phone,v_line_phone,v_line_context,v_key,v_legacy_key,v_legacy_thread,
      v_direction,v_body,v_at,v_from,v_to,v_sid
    from public.sms_relay_messages m join public.sms_relay_threads t on t.id=m.thread_id
      join public.sms_relay_numbers n on n.id=t.proxy_number_id
    where m.id=p_source_id::uuid and t.manager_user_id=m.manager_user_id;
    select m.media_urls into v_media_urls from public.sms_relay_messages m where m.id=p_source_id::uuid;
  else
    raise exception 'unsupported historical SMS source' using errcode='22023';
  end if;
  if v_owner is null or v_at is null or v_body is null or v_line_context is null or v_direction not in ('inbound','outbound') then
    raise exception 'historical SMS source unavailable' using errcode='P0002';
  end if;
  if v_role not in ('prospect','resident','applicant','vendor','manager','admin','unknown') then v_role := 'unknown'; end if;
  if v_key is null or v_key='' then
    v_key := 'unresolved:'||p_source_table||':'||p_source_id;
    v_identity_kind := 'unresolved';
  end if;
  if v_sid like 'SM%' then
    select r.first_received_at into v_prior_at from public.sms_inbound_receipts r
      where r.message_sid=v_sid and r.manager_user_id=v_owner;
    if found then v_at := v_prior_at; end if;
  end if;
  if v_role='unknown' then v_key := 'unresolved:'||coalesce(v_sid,p_source_id); end if;
  v_namespace := 'historical:'||p_source_table;
  v_source_id := p_source_id;
  perform pg_advisory_xact_lock(hashtextextended('sms-projection-owner:'||v_owner::text,0));
  if exists(select 1 from public.sms_projection_deleted_events d
      where d.owner_manager_user_id=v_owner and
       ((d.source_namespace=v_namespace and d.source_event_id=v_source_id)
        or (v_sid is not null and d.provider_sid=v_sid))) then
    return jsonb_build_object('skipped','deleted');
  end if;
  select array_agg(n.id) into v_line_candidates from public.manager_sms_numbers n
    where n.phone_number=v_line_phone and n.provision_state in ('active','released')
      and (n.manager_user_id=v_owner or exists(select 1 from public.portal_workspaces w
        where w.id=n.workspace_id and w.owner_user_id=v_owner))
      and coalesce(n.provisioned_at,n.requested_at) <= v_at
      and (n.released_at is null or v_at <= n.released_at);
  if cardinality(v_line_candidates)=1 then
    v_line_id := v_line_candidates[1];
    v_historical := false;
    if v_role='unknown' then
      v_identity_kind := 'unresolved';
      v_key := 'unresolved:'||coalesce(v_sid,p_source_id);
    elsif v_user is not null then
      v_identity_kind := 'user'; v_key := 'user:'||v_user::text;
    elsif v_phone is not null and v_phone<>'' then
      v_identity_kind := 'phone'; v_key := 'phone:'||v_phone;
    end if;
  else
    v_digest := md5(v_owner::text||':'||v_line_context);
    v_line_id := (substr(v_digest,1,8)||'-'||substr(v_digest,9,4)||'-'||substr(v_digest,13,4)||'-'||substr(v_digest,17,4)||'-'||substr(v_digest,21,12))::uuid;
    if exists(select 1 from public.manager_sms_numbers n where n.id=v_line_id) then
      raise exception 'historical line identity collision' using errcode='23505';
    end if;
  end if;
  -- Reconciliation is allowed only after source envelope, identity, and
  -- historical line epoch have all been derived. Never accept a same-ID event
  -- merely because its body/time/direction still match.
  select t.id,t.conversation_id,t.body,t.occurred_at,t.direction,t.from_phone,t.to_phone
    into v_turn,v_existing,v_prior_body,v_prior_at,v_prior_direction,v_prior_from,v_prior_to
    from public.sms_projection_turns t
    where t.owner_manager_user_id=v_owner and t.source_namespace=v_namespace and t.source_event_id=v_source_id;
  if found then
    select * into v_conversation from public.sms_projection_conversations where id=v_existing;
    if v_prior_body is distinct from v_body or v_prior_at is distinct from v_at or v_prior_direction is distinct from v_direction
       or v_prior_from is distinct from v_from or v_prior_to is distinct from v_to
       or v_conversation.counterparty_role is distinct from v_role
       or v_conversation.work_line_id is distinct from v_line_id
       or v_conversation.identity_kind is distinct from v_identity_kind
       or v_conversation.identity_key is distinct from v_key
       or v_conversation.counterparty_user_id is distinct from v_user then
      raise exception 'historical source identity changed after projection' using errcode='23505';
    end if;
    return jsonb_build_object('conversationId',v_existing,'turnId',v_turn,'inserted',false);
  end if;
  if v_sid is not null then perform pg_advisory_xact_lock(hashtextextended('sms-provider:'||v_owner::text||':'||v_sid,0)); end if;
  if v_sid is not null then
    select * into v_existing_turn from public.sms_projection_turns t
      where t.owner_manager_user_id=v_owner and t.provider_sid=v_sid;
    if found then
      select * into v_conversation from public.sms_projection_conversations where id=v_existing_turn.conversation_id;
      if v_existing_turn.body is distinct from v_body or v_existing_turn.direction is distinct from v_direction
        or v_existing_turn.from_phone is distinct from v_from or v_existing_turn.to_phone is distinct from v_to
        or v_existing_turn.occurred_at is distinct from v_at
        or (case when v_existing_turn.source_ref->>'table'=p_source_table
                   and v_existing_turn.source_ref->>'id'=p_source_id
                   and jsonb_typeof(v_existing_turn.source_ref->'historicalIdentity')='object'
            then (v_existing_turn.source_ref->'historicalIdentity'->>'counterpartyRole') is distinct from v_role
              or (v_existing_turn.source_ref->'historicalIdentity'->>'workLineId') is distinct from v_line_id::text
              or (v_existing_turn.source_ref->'historicalIdentity'->>'identityKind') is distinct from v_identity_kind
              or (v_existing_turn.source_ref->'historicalIdentity'->>'identityKey') is distinct from v_key
              or (v_existing_turn.source_ref->'historicalIdentity'->>'counterpartyUserId') is distinct from v_user::text
              or (v_existing_turn.source_ref->'historicalIdentity'->>'counterpartyPhone') is distinct from v_phone
            else v_conversation.counterparty_role is distinct from v_role
              or v_conversation.work_line_id is distinct from v_line_id
              or v_conversation.identity_kind is distinct from v_identity_kind
              or v_conversation.identity_key is distinct from v_key
              or v_conversation.counterparty_user_id is distinct from v_user end) then
        raise exception 'historical source identity conflicts with projected provider original' using errcode='23505';
      end if;
      return jsonb_build_object('skipped','provider_original_present');
    end if;
  end if;
  insert into public.sms_projection_conversations(
    owner_manager_user_id,counterparty_role,work_line_id,identity_key,identity_kind,
    counterparty_user_id,counterparty_phone,work_line_phone,legacy_conversation_key,metadata
  ) values (
    v_owner,v_role,v_line_id,v_key,v_identity_kind,v_user,v_phone,coalesce(v_line_phone,'historical:unplaced'),
    v_legacy_key,jsonb_build_object('historical',v_historical,'sendDisabled',v_historical,'sourceTable',p_source_table)
  ) on conflict(owner_manager_user_id,counterparty_role,work_line_id,identity_key)
    do update set updated_at=now() returning * into v_conversation;
  insert into public.sms_projection_turns(
    owner_manager_user_id,conversation_id,source_namespace,source_event_id,provider_sid,direction,body,occurred_at,from_phone,to_phone,source_ref
  ) values (
    v_owner,v_conversation.id,v_namespace,v_source_id,v_sid,v_direction,v_body,v_at,v_from,v_to,
    jsonb_build_object('table',p_source_table,'id',p_source_id,'historical',true,'providerSid',v_sid,'mediaUrls',v_media_urls)
  ) on conflict(owner_manager_user_id,source_namespace,source_event_id) do nothing returning id into v_turn;
  if v_turn is null then
    select t.id,t.conversation_id into v_turn,v_existing from public.sms_projection_turns t
      where t.owner_manager_user_id=v_owner and t.source_namespace=v_namespace and t.source_event_id=v_source_id;
    if v_existing is distinct from v_conversation.id then raise exception 'historical source collision' using errcode='23505'; end if;
    return jsonb_build_object('conversationId',v_conversation.id,'turnId',v_turn,'inserted',false);
  end if;
  update public.sms_projection_conversations c set
    event_count=event_count+1,
    last_body=case when c.last_event_at is null or (v_at,v_turn)>(c.last_event_at,c.last_event_id) then v_body else c.last_body end,
    last_direction=case when c.last_event_at is null or (v_at,v_turn)>(c.last_event_at,c.last_event_id) then v_direction else c.last_direction end,
    last_event_at=greatest(coalesce(c.last_event_at,v_at),v_at),
    last_event_id=case when c.last_event_at is null or (v_at,v_turn)>(c.last_event_at,c.last_event_id) then v_turn else c.last_event_id end,
    last_inbound_at=case when v_direction='inbound' and (c.last_inbound_at is null or (v_at,v_turn)>(c.last_inbound_at,c.last_inbound_event_id)) then v_at else c.last_inbound_at end,
    last_inbound_event_id=case when v_direction='inbound' and (c.last_inbound_at is null or (v_at,v_turn)>(c.last_inbound_at,c.last_inbound_event_id)) then v_turn else c.last_inbound_event_id end,
    updated_at=now()
    where c.id=v_conversation.id;
  foreach v_alias_kind in array array['legacy_key','legacy_thread'] loop
    v_alias_value := case when v_alias_kind='legacy_key' then v_legacy_key else v_legacy_thread end;
    if v_alias_value is not null and v_alias_value<>'' and v_role<>'unknown' and not exists(
        select 1 from public.sms_projection_ambiguous_aliases a where a.owner_manager_user_id=v_owner
          and a.counterparty_role=v_role and a.work_line_id=v_line_id and a.alias_kind=v_alias_kind and a.alias_value=v_alias_value) then
      insert into public.sms_projection_aliases(owner_manager_user_id,counterparty_role,work_line_id,alias_kind,alias_value,conversation_id,source_owner_id)
      values(v_owner,v_role,v_line_id,v_alias_kind,v_alias_value,v_conversation.id,v_owner)
      on conflict(owner_manager_user_id,counterparty_role,work_line_id,alias_kind,alias_value) do nothing;
      select a.conversation_id into v_existing from public.sms_projection_aliases a
        where a.owner_manager_user_id=v_owner and a.counterparty_role=v_role and a.work_line_id=v_line_id
          and a.alias_kind=v_alias_kind and a.alias_value=v_alias_value;
      if v_existing is distinct from v_conversation.id then
        insert into public.sms_projection_ambiguous_aliases(owner_manager_user_id,counterparty_role,work_line_id,alias_kind,alias_value)
          values(v_owner,v_role,v_line_id,v_alias_kind,v_alias_value) on conflict do nothing;
        delete from public.sms_projection_aliases where owner_manager_user_id=v_owner and counterparty_role=v_role
          and work_line_id=v_line_id and alias_kind=v_alias_kind and alias_value=v_alias_value;
      end if;
    end if;
  end loop;
  return jsonb_build_object('conversationId',v_conversation.id,'turnId',v_turn,'inserted',true);
end;
$$;
revoke all on function public.import_sms_projection_historical_event(text,text) from public,anon,authenticated;
grant execute on function public.import_sms_projection_historical_event(text,text) to service_role;

-- Owner-scoped lock order is shared with both projection entrypoints. Acquiring it
-- before row locks makes deletion linearize against replay/import without a
-- per-phone or cross-owner lock.
create or replace function public.delete_sms_projection_conversation(p_owner uuid,p_conversation uuid,p_actor uuid)
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare v_count integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('sms-projection-owner:'||p_owner::text,0));
  perform 1 from public.sms_projection_conversations c
    where c.id=p_conversation and c.owner_manager_user_id=p_owner and c.merged_into_id is null for update;
  if not found then raise exception 'sms projection conversation not found' using errcode='P0002'; end if;
  insert into public.sms_projection_deleted_events(owner_manager_user_id,source_namespace,source_event_id,provider_sid,deleted_by)
    select t.owner_manager_user_id,t.source_namespace,t.source_event_id,t.provider_sid,p_actor
    from public.sms_projection_turns t where t.conversation_id=p_conversation
    on conflict(owner_manager_user_id,source_namespace,source_event_id) do nothing;
  get diagnostics v_count = row_count;
  delete from public.sms_projection_conversations where id=p_conversation and owner_manager_user_id=p_owner;
  return v_count;
end;
$$;
revoke all on function public.delete_sms_projection_conversation(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.delete_sms_projection_conversation(uuid,uuid,uuid) to service_role;

-- Bind a legacy notice URL only after the backfill has proven exact source
-- marker membership into one active conversation. Conflicts become explicit
-- ambiguous aliases and never resolve by phone or first match.
create or replace function public.bind_sms_projection_legacy_thread_alias(
  p_owner uuid, p_conversation uuid, p_legacy_thread text,
  p_source_namespace text, p_source_event_id text, p_counterparty_role text,
  p_work_line_id uuid, p_occurred_at timestamptz, p_body text
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_summary public.sms_projection_conversations%rowtype; v_existing uuid;
begin
  if p_owner is null or p_conversation is null or nullif(p_legacy_thread,'') is null
     or nullif(p_source_namespace,'') is null or nullif(p_source_event_id,'') is null
     or nullif(p_counterparty_role,'') is null or p_work_line_id is null or p_occurred_at is null
     or p_body is null then
    raise exception 'invalid SMS legacy thread alias' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('sms-projection-owner:'||p_owner::text,0));
  select * into v_summary from public.sms_projection_conversations
    where id=p_conversation and owner_manager_user_id=p_owner and merged_into_id is null for update;
  if not found then return false; end if;
  if v_summary.counterparty_role is distinct from p_counterparty_role
     or v_summary.work_line_id is distinct from p_work_line_id
     or not exists(select 1 from public.sms_projection_turns t
       where t.owner_manager_user_id=p_owner and t.conversation_id=p_conversation
         and t.source_namespace=p_source_namespace and t.source_event_id=p_source_event_id
         and t.occurred_at=p_occurred_at
         and t.body is not distinct from p_body) then
    return false;
  end if;
  if exists(select 1 from public.sms_projection_ambiguous_aliases a where a.owner_manager_user_id=p_owner
      and a.counterparty_role=v_summary.counterparty_role and a.work_line_id=v_summary.work_line_id
      and a.alias_kind='legacy_thread' and a.alias_value=p_legacy_thread) then return false; end if;
  insert into public.sms_projection_aliases(owner_manager_user_id,counterparty_role,work_line_id,alias_kind,alias_value,conversation_id,source_owner_id)
    values(p_owner,v_summary.counterparty_role,v_summary.work_line_id,'legacy_thread',p_legacy_thread,p_conversation,p_owner)
    on conflict(owner_manager_user_id,counterparty_role,work_line_id,alias_kind,alias_value) do nothing;
  select conversation_id into v_existing from public.sms_projection_aliases where owner_manager_user_id=p_owner
    and counterparty_role=v_summary.counterparty_role and work_line_id=v_summary.work_line_id
    and alias_kind='legacy_thread' and alias_value=p_legacy_thread;
  if v_existing is distinct from p_conversation then
    insert into public.sms_projection_ambiguous_aliases(owner_manager_user_id,counterparty_role,work_line_id,alias_kind,alias_value)
      values(p_owner,v_summary.counterparty_role,v_summary.work_line_id,'legacy_thread',p_legacy_thread)
      on conflict do nothing;
    delete from public.sms_projection_aliases where owner_manager_user_id=p_owner
      and counterparty_role=v_summary.counterparty_role and work_line_id=v_summary.work_line_id
      and alias_kind='legacy_thread' and alias_value=p_legacy_thread;
    return false;
  end if;
  return true;
end;
$$;
revoke all on function public.bind_sms_projection_legacy_thread_alias(uuid,uuid,text,text,text,text,uuid,timestamptz,text) from public,anon,authenticated;
grant execute on function public.bind_sms_projection_legacy_thread_alias(uuid,uuid,text,text,text,text,uuid,timestamptz,text) to service_role;
