-- Manager SMS agent sessions.
--
-- Mirrors the resident SMS identity index: a verified phone can change owners,
-- so manager SMS history is keyed by the manager user as well as landlord +
-- phone. Without the user id, a recycled number newly verified by someone else
-- could inherit the prior manager's agent session and prompt history.
--
-- Additive and idempotent: no column is renamed and no existing index is
-- touched. `agent_pending_actions` is unchanged — a proposal from this surface
-- is an ordinary `portal = 'manager'` row claimed on `user_id`.

create unique index if not exists agent_sessions_manager_sms_identity_uidx
  on public.agent_sessions (landlord_id, user_id, vendor_phone_e164)
  where kind = 'manager_sms'
    and user_id is not null
    and vendor_phone_e164 is not null;

-- A manager texting their work number now reaches the manager agent instead of
-- the old blind relay, so its prepared reply needs its own route kind. Both the
-- table constraint and the RPC's own allowlist have to learn it: the RPC
-- validates independently, so widening only the constraint would still raise.
--
-- The route-kind list is an ALLOWLIST in both places, deliberately. A denylist
-- would silently accept any value it had not heard of, which is exactly how a
-- replay lands on a route nothing knows how to re-deliver.

alter table public.sms_inbound_receipts
  drop constraint if exists sms_inbound_receipts_route_kind_check;

alter table public.sms_inbound_receipts
  add constraint sms_inbound_receipts_route_kind_check
  check (
    route_kind is null
    or route_kind in (
      'manager_self_reply', 'manager_agent', 'resident_agent', 'leasing_agent', 'leasing_template'
    )
  );

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
     or p_route_kind not in (
       'manager_self_reply', 'manager_agent', 'resident_agent', 'leasing_agent', 'leasing_template'
     )
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
