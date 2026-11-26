-- A prepared reply names the conversation it belongs to.
--
-- A multi-role sender (a manager of one workspace who also rents a room run by another manager) texts one work
-- number and is answered as a RESIDENT of that other manager's workspace. The reply is persisted before transport,
-- so a Twilio retry re-sends it from the replay path — which until now assumed the owner of the work number the
-- text arrived on and would have written that resident conversation into the wrong workspace (and billed it there).
--
-- The owner and workspace the first attempt delivered to are therefore stored with the prepared reply. Nullable:
-- a receipt prepared before this migration keeps today's behaviour (the work-number owner).

alter table public.sms_inbound_receipts
  add column if not exists reply_owner_user_id uuid references auth.users (id) on delete set null,
  add column if not exists reply_workspace_id uuid;

-- The RPC gains the two arguments as a SECOND overload, added beside the 10-argument one, which stays exactly as it
-- is: schema is applied (`npm run db:push`) separately from the deploy, so between the two every inbound reply still
-- comes from code that sends the 10 old keys. Neither signature defaults an argument, so a named call resolves by its
-- key set alone - 10 keys reach the old function, 12 the new one - and the old overload is dropped in a later
-- migration once this code is live.
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
  p_reply_body text,
  p_reply_owner_user_id uuid,
  p_reply_workspace_id uuid
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
      reply_owner_user_id = p_reply_owner_user_id,
      reply_workspace_id = p_reply_workspace_id,
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
        and reply_owner_user_id is not distinct from p_reply_owner_user_id
        and reply_workspace_id is not distinct from p_reply_workspace_id
      )
    )
  returning message_sid into v_prepared;
  return v_prepared is not null;
end;
$$;

revoke execute on function public.prepare_sms_inbound_reply(
  text, text, text, uuid, uuid, uuid, uuid, uuid, text, text, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.prepare_sms_inbound_reply(
  text, text, text, uuid, uuid, uuid, uuid, uuid, text, text, uuid, uuid
) to service_role;
