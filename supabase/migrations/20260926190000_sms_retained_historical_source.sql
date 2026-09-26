-- One reviewed retained source whose receipt holder differs from the log owner.
-- This is archival provenance, never a receipt original or a work-line grant.
create or replace function public.resolve_sms_retained_historical_source(p_source_table text, p_source_id text)
returns jsonb language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare
  v_log public.inbound_sms_log%rowtype;
  v_mirror public.manager_sms_messages%rowtype;
  v_receipt public.sms_inbound_receipts%rowtype;
  v_session public.agent_sessions%rowtype;
  v_outbox public.sms_outbox%rowtype;
  v_fingerprint text;
  v_count integer;
  v_sender_key text;
begin
  if p_source_table not in ('inbound_sms_log','manager_sms_messages') or
     p_source_id is null or p_source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return jsonb_build_object('eligible',false,'reason','invalid_source');
  end if;
  if p_source_table='inbound_sms_log' then
    select * into v_log from public.inbound_sms_log where id=p_source_id::uuid;
  else
    select * into v_mirror from public.manager_sms_messages where id=p_source_id::uuid;
    if found and v_mirror.message_sid is not null then
      select * into v_log from public.inbound_sms_log where message_sid=v_mirror.message_sid;
    end if;
  end if;
  if v_log.id is null or v_log.manager_user_id is null or v_log.message_sid is null or
     v_log.created_at >= '2026-09-26 00:00:00+00'::timestamptz then
    return jsonb_build_object('eligible',false,'reason','source_unavailable');
  end if;
  select count(*) into v_count from public.inbound_sms_log where message_sid=v_log.message_sid;
  if v_count<>1 then return jsonb_build_object('eligible',false,'reason','primary_ambiguous'); end if;
  select count(*) into v_count from public.manager_sms_messages where message_sid=v_log.message_sid;
  if v_count<>1 then return jsonb_build_object('eligible',false,'reason','mirror_ambiguous'); end if;
  select * into v_mirror from public.manager_sms_messages where message_sid=v_log.message_sid;
  select * into v_receipt from public.sms_inbound_receipts where message_sid=v_log.message_sid;
  if v_receipt.message_sid is null or v_receipt.status is distinct from 'completed' or v_receipt.inbound_payload is not null or
     v_receipt.manager_user_id is null or v_receipt.manager_user_id=v_log.manager_user_id or
     v_receipt.first_received_at >= '2026-09-26 00:00:00+00'::timestamptz or
     v_log.body is null or v_log.from_phone !~ '^\+[0-9]{10,15}$' or v_log.to_phone !~ '^\+[0-9]{10,15}$' or
     v_log.counterparty_role is null or
     v_log.counterparty_role not in ('prospect','resident','applicant','vendor','manager','admin','unknown') or
     v_mirror.manager_user_id is distinct from v_log.manager_user_id or
     v_mirror.direction is distinct from 'inbound' or v_mirror.message_sid is distinct from v_log.message_sid or
     v_mirror.body is distinct from v_log.body or v_mirror.from_phone is distinct from v_log.from_phone or
     v_mirror.to_phone is distinct from v_log.to_phone or
     v_mirror.counterparty_role is distinct from v_log.counterparty_role or
     v_mirror.resident_user_id is distinct from v_log.matched_sender_user_id or
     v_mirror.created_at >= '2026-09-26 00:00:00+00'::timestamptz or
     (p_source_table='manager_sms_messages' and v_mirror.id::text<>p_source_id) then
    return jsonb_build_object('eligible',false,'reason','source_conflict');
  end if;
  v_sender_key:=regexp_replace(v_log.from_phone,'[^0-9]','','g');
  if length(v_sender_key)=11 and left(v_sender_key,1)='1' then v_sender_key:=substr(v_sender_key,2); end if;
  if v_sender_key is distinct from v_receipt.recipient_phone_key then
    return jsonb_build_object('eligible',false,'reason','sender_conflict');
  end if;
  select count(*) into v_count from public.prospect_sms_ingress where source_message_id=v_log.message_sid;
  if v_count<>0 then return jsonb_build_object('eligible',false,'reason','ingress_present'); end if;
  select count(*) into v_count from public.manager_sms_numbers n
    where n.phone_number=v_log.to_phone and n.provision_state in ('active','released')
      and coalesce(n.provisioned_at,n.requested_at)<=v_receipt.first_received_at
      and (n.released_at is null or v_receipt.first_received_at<=n.released_at);
  if v_count<>0 then return jsonb_build_object('eligible',false,'reason','line_epoch_present'); end if;
  select count(*) into v_count from public.portal_workspaces where owner_user_id=v_log.manager_user_id;
  if v_count<>1 or v_log.conversation_key is null or
     v_log.conversation_key not like v_log.manager_user_id::text||':%' then
    return jsonb_build_object('eligible',false,'reason','source_scope_changed');
  end if;
  select * into v_session from public.agent_sessions where id=v_receipt.agent_session_id;
  select * into v_outbox from public.sms_outbox where id=v_receipt.outbox_id;
  if v_session.id is null or v_session.kind is distinct from 'leasing_sms' or
     v_session.landlord_id is distinct from v_log.manager_user_id or
     v_outbox.id is null or v_outbox.manager_user_id is distinct from v_log.manager_user_id or
     v_outbox.purpose is distinct from 'manager_conversation' or
     v_outbox.counterparty_role is distinct from 'prospect' or
     v_outbox.status is distinct from 'delivered' or v_receipt.route_kind is distinct from 'leasing_agent' then
    return jsonb_build_object('eligible',false,'reason','routing_context_conflict');
  end if;
  -- No source-scope aliases or archive controls exist for this reviewed row.
  if exists(select 1 from public.manager_sms_conversation_houses h where h.manager_user_id=v_log.manager_user_id
      and h.conversation_key in (v_log.conversation_key,v_mirror.conversation_key)) or
     exists(select 1 from public.manager_tour_followup_controls c where c.manager_user_id=v_log.manager_user_id
       and c.conversation_key in (v_log.conversation_key,v_mirror.conversation_key)) or
     exists(select 1 from public.portal_inbox_thread_records n
       where n.scope='axis_portal_inbox_manager_v1' and n.row_data::text like '%'||v_log.message_sid||'%') or
     exists(select 1 from public.sms_projection_turns t where t.provider_sid=v_log.message_sid
       and (t.owner_manager_user_id<>v_log.manager_user_id or t.source_namespace<>'retained:inbound_sms_log'
         or t.source_event_id<>v_log.id::text)) then
    return jsonb_build_object('eligible',false,'reason','source_scope_or_projection_changed');
  end if;
  v_fingerprint:=encode(sha256(convert_to(jsonb_build_array('retained-sms-v1',
    v_log.id::text,v_log.manager_user_id::text,v_log.message_sid,v_log.body,v_log.from_phone,v_log.to_phone,
    v_log.counterparty_role,v_log.matched_sender_user_id::text,
    to_char(v_log.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    v_mirror.id::text,v_mirror.manager_user_id::text,v_mirror.message_sid,v_mirror.body,v_mirror.from_phone,v_mirror.to_phone,
    v_mirror.counterparty_role,v_mirror.resident_user_id::text,
    to_char(v_mirror.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    v_receipt.manager_user_id::text,v_receipt.message_sid,
    to_char(v_receipt.first_received_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    v_receipt.status,v_receipt.route_kind,v_receipt.agent_session_id::text,v_receipt.outbox_id::text)::text,'UTF8')),'hex');
  if v_fingerprint<>'0ea5bf25cd933b4f524f873fdadbbe0408914d2e6e4efa7670ff951c2c2dc00f' then
    return jsonb_build_object('eligible',false,'reason','fingerprint_mismatch');
  end if;
  return jsonb_build_object('eligible',true,'sourceTable','inbound_sms_log','sourceId',v_log.id,
    'mirrorId',v_mirror.id,'owner',v_log.manager_user_id,'receiptOwner',v_receipt.manager_user_id,
    'role',v_log.counterparty_role,'userId',v_log.matched_sender_user_id,'sid',v_log.message_sid,
    'body',v_log.body,'fromPhone',v_log.from_phone,'toPhone',v_log.to_phone,
    'occurredAt',v_log.created_at,'mirrorAt',v_mirror.created_at,'fingerprint',v_fingerprint,
    'legacyConversationKey',v_log.conversation_key);
end $$;
revoke all on function public.resolve_sms_retained_historical_source(text,text) from public,anon,authenticated;
grant execute on function public.resolve_sms_retained_historical_source(text,text) to service_role;

create or replace function public.import_sms_retained_historical_source(p_source_table text,p_source_id text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_source jsonb;
  v_owner uuid;
  v_id uuid;
  v_mirror_id uuid;
  v_sid text;
  v_line_id uuid;
  v_key text;
  v_digest text;
  v_conversation public.sms_projection_conversations%rowtype;
  v_existing public.sms_projection_turns%rowtype;
  v_turn uuid;
  v_at timestamptz;
  v_source_ref jsonb;
begin
  if p_source_table not in ('inbound_sms_log','manager_sms_messages') or
     p_source_id is null or p_source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'invalid retained SMS source' using errcode='22023';
  end if;
  -- This preliminary read derives the owner. It is not the authority for the
  -- write; all source evidence is locked and reread below.
  if p_source_table='inbound_sms_log' then
    select manager_user_id into v_owner from public.inbound_sms_log where id=p_source_id::uuid;
  else
    select l.manager_user_id into v_owner from public.manager_sms_messages m
      join public.inbound_sms_log l on l.message_sid=m.message_sid where m.id=p_source_id::uuid;
  end if;
  if v_owner is null then raise exception 'retained SMS source unavailable' using errcode='P0002'; end if;
  perform pg_advisory_xact_lock(hashtextextended('sms-projection-owner:'||v_owner::text,0));
  if p_source_table='inbound_sms_log' then
    select id,message_sid into v_id,v_sid from public.inbound_sms_log where id=p_source_id::uuid for update;
  else
    select l.id,l.message_sid into v_id,v_sid from public.manager_sms_messages m
      join public.inbound_sms_log l on l.message_sid=m.message_sid where m.id=p_source_id::uuid;
  end if;
  if v_id is null then raise exception 'retained SMS source disappeared' using errcode='P0002'; end if;
  perform 1 from public.inbound_sms_log where id=v_id for update;
  perform 1 from public.manager_sms_messages where message_sid=v_sid for update;
  perform 1 from public.sms_inbound_receipts where message_sid=v_sid for update;
  if (select manager_user_id from public.inbound_sms_log where id=v_id) is distinct from v_owner then
    raise exception 'retained SMS owner changed' using errcode='23505';
  end if;
  v_source:=public.resolve_sms_retained_historical_source(p_source_table,p_source_id);
  if v_source->>'eligible' is distinct from 'true' or v_source->>'owner' is distinct from v_owner::text then
    raise exception 'retained SMS evidence unresolved: %',coalesce(v_source->>'reason','invalid') using errcode='P0002';
  end if;
  v_mirror_id:=(v_source->>'mirrorId')::uuid;
  v_at:=(v_source->>'occurredAt')::timestamptz;
  v_key:='unresolved:inbound_sms_log:'||v_id::text;
  v_digest:=md5('retained:inbound_sms_log:'||v_owner::text||':'||v_id::text);
  v_line_id:=(substr(v_digest,1,8)||'-'||substr(v_digest,9,4)||'-'||substr(v_digest,13,4)||'-'||substr(v_digest,17,4)||'-'||substr(v_digest,21,12))::uuid;
  if exists(select 1 from public.manager_sms_numbers where id=v_line_id) then
    raise exception 'retained synthetic line collision' using errcode='23505';
  end if;
  if exists(select 1 from public.sms_projection_deleted_events d
      where d.owner_manager_user_id=v_owner and
        ((d.source_namespace='retained:inbound_sms_log' and d.source_event_id=v_id::text)
          or d.provider_sid=v_sid)) then
    return jsonb_build_object('skipped','deleted','historicalSourceMirrorAccounted',true);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('sms-provider:'||v_owner::text||':'||v_sid,0));
  v_source_ref:=jsonb_build_object('table','inbound_sms_log','id',v_id,'historical',true,
    'archiveReason','receipt_owner_conflict','fingerprint',v_source->>'fingerprint',
    'mirror',jsonb_build_object('table','manager_sms_messages','id',v_mirror_id,
      'occurredAt',v_source->>'mirrorAt'),
    'receiptOwner',v_source->>'receiptOwner','receivingEpoch','unknown',
    'legacyConversationKey',v_source->>'legacyConversationKey');
  select * into v_existing from public.sms_projection_turns t where t.owner_manager_user_id=v_owner
    and t.source_namespace='retained:inbound_sms_log' and t.source_event_id=v_id::text for update;
  if found then
    select * into v_conversation from public.sms_projection_conversations where id=v_existing.conversation_id;
    if v_existing.provider_sid is distinct from v_sid or v_existing.body is distinct from v_source->>'body'
       or v_existing.direction is distinct from 'inbound' or v_existing.occurred_at is distinct from v_at
       or v_existing.from_phone is distinct from v_source->>'fromPhone'
       or v_existing.to_phone is distinct from v_source->>'toPhone'
       or v_existing.source_ref is distinct from v_source_ref
       or v_conversation.owner_manager_user_id is distinct from v_owner
       or v_conversation.counterparty_role is distinct from v_source->>'role'
       or v_conversation.identity_kind is distinct from 'unresolved'
       or v_conversation.identity_key is distinct from v_key
       or v_conversation.work_line_id is distinct from v_line_id
       or v_conversation.counterparty_user_id is not null
       or v_conversation.counterparty_phone is not null
       or v_conversation.legacy_conversation_key is not null
       or v_conversation.work_line_phone is distinct from v_source->>'toPhone'
       or v_conversation.event_count is distinct from 1
       or v_conversation.last_body is distinct from v_source->>'body'
       or v_conversation.last_direction is distinct from 'inbound'
       or v_conversation.last_event_at is distinct from v_at
       or v_conversation.last_event_id is distinct from v_existing.id
       or v_conversation.last_inbound_at is distinct from v_at
       or v_conversation.last_inbound_event_id is distinct from v_existing.id
       or v_conversation.metadata->>'historical' is distinct from 'true'
       or v_conversation.metadata->>'archiveReason' is distinct from 'receipt_owner_conflict'
       or v_conversation.metadata->>'sendDisabled' is distinct from 'true'
       or v_conversation.metadata->>'sourceTable' is distinct from 'inbound_sms_log'
       or v_conversation.metadata->>'receivingEpoch' is distinct from 'unknown' then
      raise exception 'retained SMS projection changed' using errcode='23505';
    end if;
    return jsonb_build_object('conversationId',v_conversation.id,'turnId',v_existing.id,
      'inserted',false,'historicalSourcePreserved',true,'historicalSourceMirrorAccounted',true);
  end if;
  if exists(select 1 from public.sms_projection_turns t where t.provider_sid=v_sid) then
    raise exception 'retained SMS provider collision' using errcode='23505';
  end if;
  insert into public.sms_projection_conversations(owner_manager_user_id,counterparty_role,work_line_id,
    identity_key,identity_kind,counterparty_user_id,counterparty_phone,work_line_phone,legacy_conversation_key,metadata)
  values(v_owner,v_source->>'role',v_line_id,v_key,'unresolved',null,null,v_source->>'toPhone',null,
    jsonb_build_object('historical',true,'sendDisabled',true,'archiveReason','receipt_owner_conflict',
      'sourceTable','inbound_sms_log','receivingEpoch','unknown'))
  returning * into v_conversation;
  insert into public.sms_projection_turns(owner_manager_user_id,conversation_id,source_namespace,
    source_event_id,provider_sid,direction,body,occurred_at,from_phone,to_phone,source_ref)
  values(v_owner,v_conversation.id,'retained:inbound_sms_log',v_id::text,v_sid,'inbound',
    v_source->>'body',v_at,v_source->>'fromPhone',v_source->>'toPhone',v_source_ref)
  returning id into v_turn;
  update public.sms_projection_conversations set event_count=1,last_body=v_source->>'body',
    last_direction='inbound',last_event_at=v_at,last_event_id=v_turn,
    last_inbound_at=v_at,last_inbound_event_id=v_turn,updated_at=now()
    where id=v_conversation.id;
  return jsonb_build_object('conversationId',v_conversation.id,'turnId',v_turn,
    'inserted',true,'historicalSourcePreserved',true,'historicalSourceMirrorAccounted',true);
end $$;
revoke all on function public.import_sms_retained_historical_source(text,text) from public,anon,authenticated;
grant execute on function public.import_sms_retained_historical_source(text,text) to service_role;
