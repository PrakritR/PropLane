-- Run only against the exact staging target after migration postflight:
-- psql -X -v ON_ERROR_STOP=1 -v source_id=<private reviewed inbound UUID> -f tests/sql/sms-retained-historical-rollback-probe.sql
-- Every mutation below is enclosed in one transaction and rolled back.
\set ON_ERROR_STOP on
begin;
set local role postgres;
set local lock_timeout='3s';
set local statement_timeout='60s';
select set_config('test.retained_source_id', :'source_id', true);
create temporary table retained_probe_before on commit drop as
select (select count(*) from public.sms_projection_turns) turns,
  (select count(*) from public.sms_projection_conversations) conversations,
  (select to_jsonb(l) from public.inbound_sms_log l where id=current_setting('test.retained_source_id')::uuid) source;

do $$
declare v_id uuid:=current_setting('test.retained_source_id')::uuid; v_proof jsonb; v_mirror jsonb;
begin
  v_proof:=public.resolve_sms_retained_historical_source('inbound_sms_log',v_id::text);
  if v_proof->>'eligible' is distinct from 'true' then raise exception 'retained source failed proof: %',v_proof->>'reason'; end if;
  v_mirror:=public.resolve_sms_retained_historical_source('manager_sms_messages',v_proof->>'mirrorId');
  if v_mirror is distinct from v_proof then raise exception 'mirror and source classify differently'; end if;
  if v_proof->>'occurredAt'=v_proof->>'mirrorAt' then raise exception 'distinct source times lost'; end if;
end $$;

-- Reverse call order must create exactly one source-owned, send-disabled turn.
select public.import_sms_retained_historical_source('manager_sms_messages',
  (public.resolve_sms_retained_historical_source('inbound_sms_log',current_setting('test.retained_source_id'))->>'mirrorId'));
select public.import_sms_retained_historical_source('inbound_sms_log',current_setting('test.retained_source_id'));

do $$
declare v_id uuid:=current_setting('test.retained_source_id')::uuid; v_proof jsonb; v_turn record; v_summary record;
begin
  v_proof:=public.resolve_sms_retained_historical_source('inbound_sms_log',v_id::text);
  select * into v_turn from public.sms_projection_turns where source_namespace='retained:inbound_sms_log' and source_event_id=v_id::text;
  select * into v_summary from public.sms_projection_conversations where id=v_turn.conversation_id;
  if v_turn.id is null or v_turn.owner_manager_user_id::text<>v_proof->>'owner' or
     v_turn.occurred_at is distinct from (v_proof->>'occurredAt')::timestamptz or
     v_turn.body is distinct from v_proof->>'body' or v_turn.from_phone is distinct from v_proof->>'fromPhone' or
     v_turn.to_phone is distinct from v_proof->>'toPhone' or v_turn.provider_sid is distinct from v_proof->>'sid' or
     v_summary.identity_kind<>'unresolved' or v_summary.counterparty_user_id is not null or
     v_summary.metadata->>'sendDisabled'<>'true' or v_summary.event_count<>1 or
     v_summary.owner_manager_user_id::text<>v_proof->>'owner' or
     v_summary.owner_manager_user_id::text=v_proof->>'receiptOwner' or
     exists(select 1 from public.sms_projection_aliases where conversation_id=v_summary.id) then
    raise exception 'retained singleton projection differs';
  end if;
  if (select to_jsonb(l) from public.inbound_sms_log l where id=v_id) is distinct from
     (select source from retained_probe_before) then raise exception 'source row changed'; end if;
end $$;

-- A provider conflict after a proposed summary insertion must roll back both.
do $$
declare v_proof jsonb; v_owner uuid; v_line uuid:=gen_random_uuid(); v_summary uuid; v_before bigint;
begin
  v_proof:=public.resolve_sms_retained_historical_source('inbound_sms_log',current_setting('test.retained_source_id'));
  v_owner:=(v_proof->>'owner')::uuid;
  select count(*) into v_before from public.sms_projection_conversations;
  begin
    insert into public.sms_projection_conversations(owner_manager_user_id,counterparty_role,work_line_id,
      identity_key,identity_kind,work_line_phone) values(v_owner,'prospect',v_line,
      'phone:'||(v_proof->>'fromPhone'),'phone',v_proof->>'toPhone') returning id into v_summary;
    insert into public.sms_projection_turns(owner_manager_user_id,conversation_id,source_namespace,
      source_event_id,provider_sid,direction,body,occurred_at)
    values(v_owner,v_summary,'canonical-probe',gen_random_uuid()::text,v_proof->>'sid','inbound',
      v_proof->>'body',(v_proof->>'occurredAt')::timestamptz);
    raise exception 'provider collision did not fail';
  exception when unique_violation then null;
  end;
  if (select count(*) from public.sms_projection_conversations)<>v_before then
    raise exception 'failed canonical turn left a summary';
  end if;
end $$;

-- Deletion followed by re-import cannot resurrect this source.
do $$
declare v_proof jsonb; v_id uuid; v_owner uuid; v_conversation uuid; v_count integer; v_result jsonb;
begin
  v_proof:=public.resolve_sms_retained_historical_source('inbound_sms_log',current_setting('test.retained_source_id'));
  v_id:=(v_proof->>'sourceId')::uuid; v_owner:=(v_proof->>'owner')::uuid;
  select conversation_id into v_conversation from public.sms_projection_turns
    where owner_manager_user_id=v_owner and source_namespace='retained:inbound_sms_log' and source_event_id=v_id::text;
  v_count:=public.delete_sms_projection_conversation(v_owner,v_conversation,v_owner);
  if v_count<>1 then raise exception 'deletion tombstone absent'; end if;
  v_result:=public.import_sms_retained_historical_source('inbound_sms_log',v_id::text);
  if v_result->>'skipped'<>'deleted' or exists(select 1 from public.sms_projection_turns
    where source_namespace='retained:inbound_sms_log' and source_event_id=v_id::text) then
    raise exception 'deleted source resurrected';
  end if;
end $$;

rollback;
