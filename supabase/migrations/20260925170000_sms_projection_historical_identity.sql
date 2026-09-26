-- Dev history includes burst records without any sender phone. Preserve each
-- source as its own unresolved, send-disabled historical original.
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
  if exists(select 1 from public.sms_projection_deleted_events d
      where d.owner_manager_user_id=v_owner and
       ((d.source_namespace=v_namespace and d.source_event_id=v_source_id)
        or (v_sid is not null and d.provider_sid=v_sid))) then
    return jsonb_build_object('skipped','deleted');
  end if;
  -- An exact provider SID already projected from the live path wins. The
  -- source-table precedence above separately prevents aggregate mirror rows.
  if v_sid is not null then
    select * into v_existing_turn from public.sms_projection_turns t
      where t.owner_manager_user_id=v_owner and t.provider_sid=v_sid;
    if found then
      if v_existing_turn.body is distinct from v_body or v_existing_turn.direction is distinct from v_direction
        or (v_from is not null and v_existing_turn.from_phone is distinct from v_from)
        or (v_to is not null and v_existing_turn.to_phone is distinct from v_to)
        or v_existing_turn.occurred_at is distinct from v_at then
        raise exception 'historical source disagrees with projected provider original' using errcode='23505';
      end if;
      return jsonb_build_object('skipped','live_original_present');
    end if;
  end if;
  select t.id,t.conversation_id,t.body,t.occurred_at,t.direction
    into v_turn,v_existing,v_prior_body,v_prior_at,v_prior_direction from public.sms_projection_turns t
    where t.owner_manager_user_id=v_owner and t.source_namespace=v_namespace and t.source_event_id=v_source_id;
  if found then
    if v_prior_body is distinct from v_body or v_prior_at is distinct from v_at or v_prior_direction is distinct from v_direction then
      raise exception 'historical source changed after projection' using errcode='23505';
    end if;
    return jsonb_build_object('conversationId',v_existing,'turnId',v_turn,'inserted',false);
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
  if v_sid is not null then perform pg_advisory_xact_lock(hashtextextended('sms-provider:'||v_owner::text||':'||v_sid,0)); end if;
  if v_sid is not null then
    select * into v_existing_turn from public.sms_projection_turns t
      where t.owner_manager_user_id=v_owner and t.provider_sid=v_sid;
    if found then
      if v_existing_turn.body is distinct from v_body or v_existing_turn.direction is distinct from v_direction
        or (v_from is not null and v_existing_turn.from_phone is distinct from v_from)
        or (v_to is not null and v_existing_turn.to_phone is distinct from v_to)
        or v_existing_turn.occurred_at is distinct from v_at then
        raise exception 'historical source disagrees with projected provider original' using errcode='23505';
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
