-- Receipt payloads may be cleared. Resolve historical originals from a present
-- valid envelope or an independently retained exact log, regardless of whether
-- live processing completed. The typed runtime adapter keeps the live gate.
-- This service-only function is also the historical importer's source gate.
create or replace function public.resolve_sms_completed_receipt_original(p_sid text, p_expected_owner uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_receipt public.sms_inbound_receipts%rowtype;
  v_log public.inbound_sms_log%rowtype;
  v_ingress public.prospect_sms_ingress%rowtype;
  v_burst public.prospect_sms_bursts%rowtype;
  v_log_count integer;
  v_ingress_count integer;
  v_line_count integer;
  v_line_id uuid;
  v_body text;
  v_from text;
  v_to text;
  v_owner uuid;
  v_role text := 'unknown';
  v_user uuid;
  v_key text;
  v_sender_key text;
  v_trim_chars text := U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
begin
  if p_sid is null or p_sid = '' or p_expected_owner is null then
    return jsonb_build_object('ok',false,'reason','invalid_request');
  end if;
  select * into v_receipt from public.sms_inbound_receipts where message_sid = p_sid;
  if not found then return jsonb_build_object('ok',false,'reason','receipt_missing'); end if;
  v_owner := v_receipt.manager_user_id;
  if v_receipt.first_received_at is null or v_owner is null then
    return jsonb_build_object('ok',false,'reason','receipt_invalid');
  end if;
  select count(*) into v_log_count from public.inbound_sms_log l where l.message_sid=p_sid;
  if v_log_count > 1 then return jsonb_build_object('ok',false,'reason','log_ambiguous'); end if;
  if v_log_count=1 then
    select * into v_log from public.inbound_sms_log l where l.message_sid=p_sid;
  end if;
  select count(*) into v_ingress_count from public.prospect_sms_ingress i where i.source_message_id=p_sid;
  if v_ingress_count > 1 then return jsonb_build_object('ok',false,'reason','ingress_ambiguous'); end if;
  if v_ingress_count=1 then
    select * into v_ingress from public.prospect_sms_ingress i where i.source_message_id=p_sid;
  end if;
  if v_receipt.inbound_payload is not null then
    if jsonb_typeof(v_receipt.inbound_payload->'body') is distinct from 'string'
       or jsonb_typeof(v_receipt.inbound_payload->'fromPhone') is distinct from 'string'
       or jsonb_typeof(v_receipt.inbound_payload->'toPhone') is distinct from 'string' then
      return jsonb_build_object('ok',false,'reason','payload_invalid');
    end if;
    v_body := v_receipt.inbound_payload->>'body';
    v_from := v_receipt.inbound_payload->>'fromPhone';
    v_to := v_receipt.inbound_payload->>'toPhone';
  elsif v_receipt.status in ('completed','processing','retryable') and v_log_count = 1 then
    v_body := v_log.body; v_from := v_log.from_phone; v_to := v_log.to_phone;
  else
    return jsonb_build_object('ok',false,'reason','original_missing');
  end if;
  v_sender_key := regexp_replace(coalesce(v_from,''),'[^0-9]','','g');
  if length(v_sender_key)=11 and left(v_sender_key,1)='1' then
    v_sender_key := substr(v_sender_key,2);
  end if;
  if v_from is null or v_to is null or v_from !~ '^\+[0-9]{10,15}$' or v_to !~ '^\+[0-9]{10,15}$'
     or v_sender_key is distinct from v_receipt.recipient_phone_key then
    return jsonb_build_object('ok',false,'reason','wire_invalid');
  end if;
  if v_log_count = 1 then
    if v_log.manager_user_id is distinct from v_owner or v_log.body is distinct from v_body
       or v_log.from_phone is distinct from v_from or v_log.to_phone is distinct from v_to
       or v_log.counterparty_role is null
       or v_log.counterparty_role not in ('prospect','resident','applicant','vendor','manager','admin','unknown') then
      return jsonb_build_object('ok',false,'reason','log_conflict');
    end if;
    v_role := v_log.counterparty_role;
    v_user := v_log.matched_sender_user_id;
    v_key := v_log.conversation_key;
  end if;
  if v_ingress_count = 1 then
    select * into v_burst from public.prospect_sms_bursts where id=v_ingress.burst_id;
    if not found or v_ingress.channel <> 'twilio' or v_burst.channel <> 'sms'
       or v_burst.counterparty_role <> 'prospect'
       or v_ingress.manager_user_id is distinct from v_burst.manager_user_id
       or v_burst.counterparty_phone_e164 is distinct from v_from
       or v_burst.reply_from_number is distinct from v_to
       or (v_log_count=1 and (v_role <> 'prospect' or v_user is not null))
       -- Webhook String.trim() precedes record_prospect_sms_ingress left(...,2000).
       -- btrim's explicit Unicode set is ECMAScript WhiteSpace + LineTerminator.
       -- PostgreSQL left counts Unicode code points, including astral characters.
       or v_ingress.body is distinct from left(btrim(v_body,v_trim_chars),2000) then
      return jsonb_build_object('ok',false,'reason','ingress_conflict');
    end if;
    v_owner := v_ingress.manager_user_id;
    v_role := 'prospect'; v_user := null;
    -- One exact receiving epoch must bind the receipt holder to the
    -- projected workspace owner. A workspace match alone cannot authorize
    -- an unrelated receipt holder. Legacy unplaced rows belong to the holder.
    select count(*), (array_agg(n.id))[1] into v_line_count,v_line_id
      from public.manager_sms_numbers n
      left join public.portal_workspaces w on w.id=n.workspace_id
      where n.phone_number=v_to and n.provision_state in ('active','released')
        and n.manager_user_id=v_receipt.manager_user_id
        and (case when n.workspace_id is null then n.manager_user_id else w.owner_user_id end)=v_owner
        and coalesce(n.provisioned_at,n.requested_at) <= v_receipt.first_received_at
        and (n.released_at is null or v_receipt.first_received_at <= n.released_at);
    if v_line_count <> 1 then
      return jsonb_build_object('ok',false,'reason','work_line_unproven');
    end if;
  end if;
  if v_owner is distinct from p_expected_owner then
    return jsonb_build_object('ok',false,'reason','owner_mismatch');
  end if;
  return jsonb_build_object('ok',true,'sid',p_sid,'receiptOwner',v_receipt.manager_user_id,
    'owner',v_owner,'status',v_receipt.status,'body',v_body,'fromPhone',v_from,'toPhone',v_to,
    'occurredAt',v_receipt.first_received_at,'role',v_role,'userId',v_user,
    'conversationKey',v_key,'workLineId',v_line_id,'ingress',v_ingress_count=1,
    'source',case when v_receipt.inbound_payload is null then 'durable_log' else 'receipt_payload' end);
end $$;
revoke all on function public.resolve_sms_completed_receipt_original(text,uuid) from public, anon, authenticated;
grant execute on function public.resolve_sms_completed_receipt_original(text,uuid) to service_role;

-- The importer body below is migration 180 with only its inbound source-selection
-- blocks strengthened. Its owner lock, tombstone, identity and ACL logic stay intact.
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
  v_original jsonb;
  v_proven_line_id uuid;
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
    if v_owner is not null and exists(select 1 from public.prospect_sms_ingress i
        where i.source_message_id=p_source_id and i.channel='twilio') then
      v_original := public.resolve_sms_completed_receipt_original(p_source_id,v_owner);
      if v_original->>'ok' is distinct from 'true' then
        raise exception 'historical inbound original unresolved: %',v_original->>'reason' using errcode='P0002';
      end if;
      v_body := v_original->>'body'; v_from := v_original->>'fromPhone';
      v_to := v_original->>'toPhone'; v_line_phone := v_to;
      v_line_context := 'work:'||v_to; v_phone := v_from;
      v_at := (v_original->>'occurredAt')::timestamptz;
      v_proven_line_id := nullif(v_original->>'workLineId','')::uuid;
      v_key := v_owner::text||':prospect:'||v_from;
      v_legacy_key := v_key;
    end if;
  elsif p_source_table = 'inbound_sms_log' then
    select l.manager_user_id,l.counterparty_role,l.matched_sender_user_id,l.from_phone,l.to_phone,
      'work:'||l.to_phone,
      coalesce(nullif(l.conversation_key,''),'unresolved:inbound_sms_log:'||l.id::text),
      l.conversation_key,null::text,'inbound',l.body,l.created_at,l.from_phone,l.to_phone,l.message_sid
    into v_owner,v_role,v_user,v_phone,v_line_phone,v_line_context,v_key,v_legacy_key,v_legacy_thread,
      v_direction,v_body,v_at,v_from,v_to,v_sid
    from public.inbound_sms_log l where l.id=p_source_id::uuid;
    if v_sid is not null and exists(select 1 from public.sms_inbound_receipts r
        where r.message_sid=v_sid) then
      -- A co-manager transport log is held by A while the prospect ingress
      -- belongs to workspace owner B. Resolve against that exact SID's ingress
      -- owner; the resolver proves the A-held receiving line in B's workspace.
      select i.manager_user_id into v_owner from public.prospect_sms_ingress i
        where i.source_message_id=v_sid and i.channel='twilio';
      if v_owner is null then
        select l.manager_user_id into v_owner from public.inbound_sms_log l where l.id=p_source_id::uuid;
      end if;
      v_original := public.resolve_sms_completed_receipt_original(v_sid,v_owner);
      if v_original->>'ok' is distinct from 'true' then
        raise exception 'historical inbound original unresolved: %',v_original->>'reason' using errcode='P0002';
      end if;
      v_body := v_original->>'body'; v_from := v_original->>'fromPhone';
      v_to := v_original->>'toPhone'; v_line_phone := v_to;
      v_line_context := 'work:'||v_to; v_phone := v_from;
      v_at := (v_original->>'occurredAt')::timestamptz;
      v_proven_line_id := nullif(v_original->>'workLineId','')::uuid;
      v_role := v_original->>'role'; v_user := nullif(v_original->>'userId','')::uuid;
      if (v_original->>'owner') is distinct from (v_original->>'receiptOwner')
         or (v_original->>'ingress') = 'true' then
        v_key := v_owner::text||':'||v_role||':'||coalesce(v_user::text,v_from);
        v_legacy_key := v_key;
      end if;
    end if;
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
  if v_proven_line_id is not null and
     (cardinality(v_line_candidates) is distinct from 1 or v_line_candidates[1] is distinct from v_proven_line_id) then
    raise exception 'historical inbound work line conflicts with original proof' using errcode='23505';
  end if;
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

-- Historic released line epochs are scanned by exact receiving phone and time.
create index if not exists manager_sms_numbers_historic_phone_epoch_idx
  on public.manager_sms_numbers (phone_number,(coalesce(provisioned_at,requested_at)),released_at)
  where provision_state in ('active','released');

-- Backfill reads only receipts that still retain an original payload. The
-- recovery index also filters by unfinished status, so it cannot serve this
-- status-agnostic (first_received_at,message_sid) cursor traversal.
create index if not exists sms_inbound_receipts_payload_cursor_idx
  on public.sms_inbound_receipts (first_received_at,message_sid)
  where inbound_payload is not null;
