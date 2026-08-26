-- Durable prepared-reply state for Twilio webhook retries. A provider retry
-- may resend a prepared reply, but it must never rerun an agent turn or a
-- confirmation-gated write that already happened.

alter table public.agent_messages
  add column if not exists source_message_sid text,
  add column if not exists trace_id text;

create unique index if not exists agent_messages_sms_user_source_sid_uidx
  on public.agent_messages (source_message_sid)
  where source_message_sid is not null and role = 'user';

alter table public.sms_inbound_receipts
  add column if not exists route_kind text,
  add column if not exists counterparty_user_id uuid references auth.users (id) on delete set null,
  add column if not exists agent_session_id uuid references public.agent_sessions (id) on delete set null,
  add column if not exists inbound_agent_message_id uuid references public.agent_messages (id) on delete set null,
  add column if not exists assistant_agent_message_id uuid references public.agent_messages (id) on delete set null,
  add column if not exists pending_action_id uuid references public.agent_pending_actions (id) on delete set null,
  add column if not exists turn_trace_id text,
  add column if not exists reply_body text,
  add column if not exists reply_prepared_at timestamptz,
  add column if not exists outbox_id uuid references public.sms_outbox (id) on delete set null,
  add column if not exists reply_enqueued_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'sms_inbound_receipts_route_kind_check'
  ) then
    alter table public.sms_inbound_receipts
      add constraint sms_inbound_receipts_route_kind_check
      check (route_kind is null or route_kind in ('manager_self_reply', 'resident_agent', 'leasing_agent', 'leasing_template'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'sms_inbound_receipts_reply_body_check'
  ) then
    alter table public.sms_inbound_receipts
      add constraint sms_inbound_receipts_reply_body_check
      check (reply_body is null or char_length(reply_body) between 1 and 1600);
  end if;
end $$;

create index if not exists sms_inbound_receipts_outbox_idx
  on public.sms_inbound_receipts (outbox_id) where outbox_id is not null;
create index if not exists sms_inbound_receipts_pending_action_idx
  on public.sms_inbound_receipts (pending_action_id) where pending_action_id is not null;

create or replace function public.prepare_sms_inbound_reply(
  p_message_sid text,
  p_worker_id text,
  p_route_kind text,
  p_counterparty_user_id uuid,
  p_agent_session_id uuid,
  p_inbound_agent_message_id uuid,
  p_assistant_agent_message_id uuid,
  p_pending_action_id uuid,
  p_turn_trace_id text,
  p_reply_body text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_prepared text;
begin
  if coalesce(trim(p_message_sid), '') = ''
     or coalesce(trim(p_worker_id), '') = ''
     or p_route_kind not in ('manager_self_reply', 'resident_agent', 'leasing_agent', 'leasing_template')
     or char_length(coalesce(p_reply_body, '')) not between 1 and 1600 then
    raise exception 'invalid inbound prepared reply';
  end if;

  update public.sms_inbound_receipts
  set route_kind = p_route_kind,
      counterparty_user_id = p_counterparty_user_id,
      agent_session_id = p_agent_session_id,
      inbound_agent_message_id = p_inbound_agent_message_id,
      assistant_agent_message_id = p_assistant_agent_message_id,
      pending_action_id = p_pending_action_id,
      turn_trace_id = p_turn_trace_id,
      reply_body = p_reply_body,
      reply_prepared_at = coalesce(reply_prepared_at, now()),
      updated_at = now()
  where message_sid = p_message_sid
    and lease_owner = p_worker_id
    and status = 'processing'
    and lease_expires_at > now()
    and (
      reply_body is null
      or (
        route_kind = p_route_kind
        and counterparty_user_id is not distinct from p_counterparty_user_id
        and agent_session_id is not distinct from p_agent_session_id
        and inbound_agent_message_id is not distinct from p_inbound_agent_message_id
        and assistant_agent_message_id is not distinct from p_assistant_agent_message_id
        and pending_action_id is not distinct from p_pending_action_id
        and turn_trace_id is not distinct from p_turn_trace_id
        and reply_body = p_reply_body
      )
    )
  returning message_sid into v_prepared;
  return v_prepared is not null;
end;
$$;

create or replace function public.attach_sms_inbound_outbox(
  p_message_sid text,
  p_worker_id text,
  p_outbox_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_attached text;
begin
  if coalesce(trim(p_message_sid), '') = ''
     or coalesce(trim(p_worker_id), '') = ''
     or p_outbox_id is null then
    raise exception 'invalid inbound outbox link';
  end if;
  update public.sms_inbound_receipts
  set outbox_id = p_outbox_id,
      reply_enqueued_at = coalesce(reply_enqueued_at, now()),
      updated_at = now()
  where message_sid = p_message_sid
    and lease_owner = p_worker_id
    and status = 'processing'
    and lease_expires_at > now()
    and reply_body is not null
    and (outbox_id is null or outbox_id = p_outbox_id)
  returning message_sid into v_attached;
  return v_attached is not null;
end;
$$;

revoke all on table public.sms_inbound_receipts from anon, authenticated;
revoke execute on function public.prepare_sms_inbound_reply(text, text, text, uuid, uuid, uuid, uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.attach_sms_inbound_outbox(text, text, uuid) from public, anon, authenticated;
grant execute on function public.prepare_sms_inbound_reply(text, text, text, uuid, uuid, uuid, uuid, uuid, text, text) to service_role;
grant execute on function public.attach_sms_inbound_outbox(text, text, uuid) to service_role;
