-- One-number SMS: transport workstream (additive, idempotent).
-- 1. Workspace stamps the database can derive itself (receipts, projection turns).
-- 2. Shared-line conversation identity: one conversation per person PER WORKSPACE
--    even when two workspaces share an owner.
-- Spec: docs/agents/one-number-spec.md · map: docs/agents/one-number.md (W2).

-- 1a. sms_inbound_receipts.workspace_id <- the workspaceId the claim payload carries.
create or replace function public.stamp_sms_receipt_workspace()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_workspace uuid;
begin
  if new.workspace_id is null and new.inbound_payload is not null then
    begin
      v_workspace := nullif(new.inbound_payload->>'workspaceId', '')::uuid;
    exception when others then
      v_workspace := null;
    end;
    if v_workspace is not null and exists (select 1 from public.portal_workspaces w where w.id = v_workspace) then
      new.workspace_id := v_workspace;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists sms_inbound_receipts_stamp_workspace on public.sms_inbound_receipts;
create trigger sms_inbound_receipts_stamp_workspace
  before insert or update of inbound_payload on public.sms_inbound_receipts
  for each row execute function public.stamp_sms_receipt_workspace();

-- 1b. sms_projection_turns.workspace_id <- the conversation's workspace: the
-- stamped workspace, else the workspace of its work-number line, else (shared
-- line) the workspace the synthetic work line id names.
create or replace function public.stamp_sms_projection_turn_workspace()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.workspace_id is null then
    select coalesce(c.workspace_id, n.workspace_id, w.id)
      into new.workspace_id
      from public.sms_projection_conversations c
      left join public.manager_sms_numbers n on n.id = c.work_line_id
      left join public.portal_workspaces w
        on w.id = c.work_line_id and w.owner_user_id = c.owner_manager_user_id
     where c.id = new.conversation_id;
  end if;
  return new;
end;
$$;

drop trigger if exists sms_projection_turns_stamp_workspace on public.sms_projection_turns;
create trigger sms_projection_turns_stamp_workspace
  before insert on public.sms_projection_turns
  for each row execute function public.stamp_sms_projection_turn_workspace();

-- 2. Shared-line conversations ---------------------------------------------------
-- On the shared number there is no manager_sms_numbers row, so a conversation
-- lives on a SYNTHETIC work line whose id IS the workspace id. The existing key
-- (owner, role, work_line_id, identity_key) therefore already separates two
-- workspaces of one owner; the partial unique index below states it outright on
-- the stamped workspace and cannot be satisfied by a work-number conversation.
alter table public.sms_projection_conversations
  add column if not exists line_kind text not null default 'work_number';

create unique index if not exists sms_projection_conversations_shared_workspace_uidx
  on public.sms_projection_conversations (owner_manager_user_id, workspace_id, counterparty_role, identity_key)
  where line_kind = 'shared' and merged_into_id is null;

-- project_shared_line_event: the shared-line twin of project_sms_conversation_event.
-- Same event shape; additionally requires `workspaceId` (== workLineId), a workspace
-- this owner holds, and the configured shared number on one side of the wire.
create or replace function public.project_shared_line_event(p_event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner uuid := nullif(p_event->>'ownerManagerUserId','')::uuid;
  v_role text := p_event->>'counterpartyRole';
  v_workspace uuid := nullif(p_event->>'workspaceId','')::uuid;
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
  v_shared text;
  v_conversation public.sms_projection_conversations%rowtype;
  v_turn_id uuid;
  v_inserted boolean := false;
  v_existing uuid;
  v_prior public.sms_projection_turns%rowtype;
begin
  if v_owner is null or v_workspace is null or v_line is null or v_line <> v_workspace
     or v_role is null or v_role not in ('prospect','resident','applicant','vendor','manager','admin','unknown')
     or v_identity is null or v_identity = '' or v_kind is null or v_kind not in ('phone','user','unresolved')
     or v_direction is null or v_direction not in ('inbound','outbound') or v_body is null or v_occurred is null
     or v_namespace is null or v_namespace = '' or v_source_id is null or v_source_id = '' then
    raise exception 'invalid shared line projection event' using errcode = '22023';
  end if;
  if v_role = 'unknown' and (v_kind <> 'unresolved' or v_identity <> 'unresolved:' || v_source_id) then
    raise exception 'unknown SMS identity must be exact event scoped' using errcode = '22023';
  end if;
  if not exists (select 1 from public.portal_workspaces w where w.id = v_workspace and w.owner_user_id = v_owner) then
    raise exception 'shared line workspace is not held by owner' using errcode = '42501';
  end if;
  select c.shared_number_e164 into v_shared from public.sms_runtime_config c where c.singleton = true;
  if v_shared is null or (v_shared is distinct from v_from and v_shared is distinct from v_to) then
    raise exception 'shared line number is not on this event' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('sms-projection-owner:'||v_owner::text,0));
  if exists (select 1 from public.sms_projection_deleted_events d
      where d.owner_manager_user_id = v_owner
        and ((d.source_namespace = v_namespace and d.source_event_id = v_source_id)
          or (v_source_id ~ '^(SM|MM)[0-9a-fA-F]{32}$' and d.provider_sid = v_source_id))) then
    return jsonb_build_object('skipped','deleted');
  end if;

  insert into public.sms_projection_conversations(
    owner_manager_user_id,counterparty_role,work_line_id,identity_key,identity_kind,
    counterparty_user_id,counterparty_phone,work_line_phone,legacy_conversation_key,metadata,
    workspace_id,line_kind
  ) values (
    v_owner,v_role,v_line,v_identity,v_kind,
    nullif(p_event->>'counterpartyUserId','')::uuid,v_phone,v_shared,
    nullif(p_event->>'legacyConversationKey',''),
    case when jsonb_typeof(p_event->'metadata') = 'object' then p_event->'metadata' else '{}'::jsonb end,
    v_workspace,'shared'
  ) on conflict(owner_manager_user_id,counterparty_role,work_line_id,identity_key)
    do update set
      counterparty_user_id = coalesce(public.sms_projection_conversations.counterparty_user_id, excluded.counterparty_user_id),
      counterparty_phone = coalesce(excluded.counterparty_phone, public.sms_projection_conversations.counterparty_phone),
      legacy_conversation_key = coalesce(public.sms_projection_conversations.legacy_conversation_key, excluded.legacy_conversation_key),
      metadata = public.sms_projection_conversations.metadata || excluded.metadata,
      workspace_id = coalesce(public.sms_projection_conversations.workspace_id, excluded.workspace_id),
      updated_at = now()
  returning * into v_conversation;

  insert into public.sms_projection_turns(owner_manager_user_id,conversation_id,source_namespace,source_event_id,provider_sid,direction,body,occurred_at,from_phone,to_phone,source_ref,workspace_id)
  values(v_owner,v_conversation.id,v_namespace,v_source_id,
    case when v_namespace like 'twilio:%' and v_source_id ~ '^(SM|MM)[0-9a-fA-F]{32}$' then v_source_id else null end,
    v_direction,v_body,v_occurred,v_from,v_to,
    case when jsonb_typeof(p_event->'sourceRef') = 'object' then p_event->'sourceRef' else '{}'::jsonb end,
    v_workspace)
  on conflict(owner_manager_user_id,source_namespace,source_event_id) do nothing returning id into v_turn_id;
  v_inserted := v_turn_id is not null;
  if not v_inserted then
    select id,conversation_id into v_turn_id,v_existing from public.sms_projection_turns
      where owner_manager_user_id = v_owner and source_namespace = v_namespace and source_event_id = v_source_id;
    select * into v_prior from public.sms_projection_turns where id = v_turn_id;
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
    where c.id = v_conversation.id returning * into v_conversation;
  end if;
  return jsonb_build_object('conversationId',v_conversation.id,'turnId',v_turn_id,'inserted',v_inserted,'eventCount',v_conversation.event_count);
end;
$$;

revoke all on function public.project_shared_line_event(jsonb) from public, anon, authenticated;
grant execute on function public.project_shared_line_event(jsonb) to service_role;
