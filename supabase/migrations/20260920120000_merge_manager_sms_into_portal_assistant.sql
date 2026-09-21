-- Manager self-SMS and the in-site PropLane Assistant are one conversation.
-- Fold successful legacy manager_sms sessions into the authenticated actor's
-- workspace-scoped portal chat. Transport rows are removed only when an exact
-- assistant turn or its inbound-reply outbox record proves they are mirrors.

-- Some long-lived projects installed the workspace bundle under an apply-time
-- ledger name but missed this additive session column. Keep this migration
-- self-contained so the scoped session RPC and history merge never depend on
-- that historical ledger shape.
alter table public.agent_sessions
  add column if not exists workspace_id uuid;

create index if not exists agent_sessions_portal_chat_workspace_idx
  on public.agent_sessions (user_id, portal, workspace_id, updated_at desc)
  where kind = 'portal_chat';

alter table public.sms_outbox
  add column if not exists suppress_conversation_log boolean not null default false;

create unique index if not exists agent_messages_assistant_source_sid_uniq
  on public.agent_messages (source_message_sid)
  where source_message_sid is not null and role = 'assistant';

create or replace function public.find_or_create_manager_sms_portal_session(
  p_actor_user_id uuid,
  p_workspace_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session_id uuid;
begin
  if p_actor_user_id is null then
    raise exception 'actor is required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    p_actor_user_id::text || ':' || coalesce(p_workspace_id::text, 'default'), 0
  ));
  select id into v_session_id
  from public.agent_sessions
  where kind = 'portal_chat'
    and portal = 'manager'
    and landlord_id = p_actor_user_id
    and user_id = p_actor_user_id
    and workspace_id is not distinct from p_workspace_id
  order by updated_at desc, id
  limit 1;
  if v_session_id is null then
    insert into public.agent_sessions (
      landlord_id, user_id, workspace_id, portal, kind, title, status
    ) values (
      p_actor_user_id, p_actor_user_id, p_workspace_id,
      'manager', 'portal_chat', 'PropLane Assistant', 'active'
    ) returning id into v_session_id;
  end if;
  return v_session_id;
end;
$$;

revoke all on function public.find_or_create_manager_sms_portal_session(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.find_or_create_manager_sms_portal_session(uuid, uuid)
  to service_role;

-- Null portal-chat workspace ids are the pre-workspace representation of the
-- actor's default workspace. Normalize them before matching legacy SMS turns.
update public.agent_sessions session
set workspace_id = workspace.id
from public.portal_workspaces workspace
where session.kind = 'portal_chat'
  and session.portal = 'manager'
  and session.workspace_id is null
  and workspace.owner_user_id = session.user_id
  and workspace.is_default;

-- Legacy sessions were keyed by actor phone, not destination work number. If
-- one session reached multiple workspaces, choosing one would silently move
-- another workspace's history. Abort the migration instead of guessing.
do $$
begin
  if exists (
    select message.session_id
    from public.agent_messages message
    join public.agent_sessions session on session.id = message.session_id
    join public.inbound_sms_log inbound on inbound.message_sid = message.source_message_sid
    join public.manager_sms_numbers number
      on public.axis_sms_phone_ref(number.phone_number) = public.axis_sms_phone_ref(inbound.to_phone)
    where session.kind = 'manager_sms'
      and message.role = 'user'
      and number.workspace_id is not null
    group by message.session_id
    having count(distinct number.workspace_id) > 1
  ) then
    raise exception 'manager_sms migration blocked: a legacy session spans multiple workspaces';
  end if;
end;
$$;

create temporary table manager_sms_session_merge on commit drop as
with legacy_with_workspace as (
  select session.id, session.landlord_id, session.user_id, session.updated_at,
         coalesce(session.workspace_id, routed.workspace_id) as workspace_id
  from public.agent_sessions session
  left join lateral (
    select number.workspace_id
    from public.agent_messages message
    join public.inbound_sms_log inbound
      on inbound.message_sid = message.source_message_sid
    join public.manager_sms_numbers number
      on public.axis_sms_phone_ref(number.phone_number) = public.axis_sms_phone_ref(inbound.to_phone)
    where message.session_id = session.id
      and message.role = 'user'
      and message.source_message_sid is not null
    order by message.created_at desc
    limit 1
  ) routed on true
  where session.kind = 'manager_sms' and session.user_id is not null
),
latest_portal as (
  select distinct on (user_id, workspace_id) user_id, workspace_id, id
  from public.agent_sessions
  where kind = 'portal_chat' and portal = 'manager'
    and user_id is not null and landlord_id = user_id
  order by user_id, workspace_id, updated_at desc, id
),
latest_legacy as (
  select distinct on (user_id, workspace_id) user_id, workspace_id, id
  from legacy_with_workspace
  order by user_id, workspace_id, updated_at desc, id
)
select legacy.id as source_session_id,
       coalesce(portal.id, target_legacy.id) as target_session_id,
       legacy.user_id as actor_user_id,
       legacy.workspace_id,
       legacy.updated_at as source_updated_at
from legacy_with_workspace legacy
left join latest_portal portal
  on portal.user_id = legacy.user_id
 and portal.workspace_id is not distinct from legacy.workspace_id
join latest_legacy target_legacy
  on target_legacy.user_id = legacy.user_id
 and target_legacy.workspace_id is not distinct from legacy.workspace_id;

update public.agent_messages message
set session_id = merge.target_session_id,
    landlord_id = merge.actor_user_id,
    portal = 'manager'
from manager_sms_session_merge merge
where message.session_id = merge.source_session_id;

update public.agent_pending_actions action
set session_id = merge.target_session_id
from manager_sms_session_merge merge
where action.session_id = merge.source_session_id
  and merge.source_session_id <> merge.target_session_id;

update public.sms_inbound_receipts receipt
set agent_session_id = merge.target_session_id
from manager_sms_session_merge merge
where receipt.agent_session_id = merge.source_session_id
  and merge.source_session_id <> merge.target_session_id;

update public.agent_sessions target
set updated_at = greatest(target.updated_at, merged.latest_source_update)
from (
  select target_session_id, max(source_updated_at) as latest_source_update
  from manager_sms_session_merge
  group by target_session_id
) merged
where target.id = merged.target_session_id;

delete from public.agent_sessions source
using manager_sms_session_merge merge
where source.id = merge.source_session_id
  and merge.source_session_id <> merge.target_session_id;

update public.agent_sessions target
set landlord_id = merge.actor_user_id,
    workspace_id = merge.workspace_id,
    kind = 'portal_chat',
    portal = 'manager',
    vendor_phone_e164 = null,
    status = 'active',
    title = coalesce(nullif(trim(target.title), ''), 'PropLane Assistant')
from manager_sms_session_merge merge
where target.id = merge.target_session_id
  and target.kind = 'manager_sms';

-- Inbound transport copies are safe to remove only when the exact provider SID
-- is already stored as a user turn in the consolidated portal transcript.
delete from public.inbound_sms_log inbound
using public.agent_messages message, public.agent_sessions session
where message.source_message_sid = inbound.message_sid
  and message.role = 'user'
  and message.channel = 'sms'
  and session.id = message.session_id
  and session.kind = 'portal_chat'
  and session.portal = 'manager';

-- Historical assistant replies used an inbound_reply_<inbound SID> dedupe key.
-- This exact join excludes manager notifications, team notices, voice notes,
-- and ordinary manager-to-manager messages even though they share the role.
update public.sms_outbox outbox
set suppress_conversation_log = true
where outbox.dedupe_key like 'inbound\_reply\_%' escape '\'
  and exists (
    select 1
    from public.sms_inbound_receipts receipt
    join public.agent_messages message on message.id = receipt.assistant_agent_message_id
    join public.agent_sessions session on session.id = message.session_id
    where receipt.outbox_id = outbox.id
      and message.role = 'assistant'
      and message.content = outbox.body
      and session.kind = 'portal_chat'
      and session.portal = 'manager'
  );

delete from public.manager_sms_messages transport
using public.sms_outbox outbox
where transport.message_sid = outbox.provider_message_sid
  and outbox.dedupe_key like 'inbound\_reply\_%' escape '\'
  and exists (
    select 1
    from public.sms_inbound_receipts receipt
    join public.agent_messages message on message.id = receipt.assistant_agent_message_id
    join public.agent_sessions session on session.id = message.session_id
    where receipt.outbox_id = outbox.id
      and message.role = 'assistant'
      and message.content = outbox.body
      and session.kind = 'portal_chat'
      and session.portal = 'manager'
  );

comment on column public.sms_outbox.suppress_conversation_log is
  'True when delivery is authorized and audited by the outbox but its content already has a canonical non-Communication transcript.';
