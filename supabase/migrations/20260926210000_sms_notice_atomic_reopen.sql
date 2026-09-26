-- Append a manager SMS compatibility notice and reopen its legacy archive
-- controls in the same transaction. A failed control update must leave no
-- delivered message marker, so the webhook can retry the exact SID.
create or replace function public.append_manager_sms_inbox_notice(
  p_owner uuid,
  p_thread_id text,
  p_thread_type text,
  p_message_id text,
  p_incoming jsonb,
  p_message jsonb,
  p_inbound boolean,
  p_control_keys text[]
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_thread public.portal_inbox_thread_records%rowtype;
  v_messages jsonb;
  v_reopens boolean;
begin
  if p_owner is null or nullif(p_thread_id, '') is null or nullif(p_message_id, '') is null
     or jsonb_typeof(p_incoming) <> 'object' or jsonb_typeof(p_message) <> 'object'
     or p_message->>'id' is distinct from p_message_id
     or p_incoming->>'id' is distinct from p_thread_id
     or p_incoming->>'rootMessageId' is distinct from p_message_id
     or p_incoming->>'ownerUserId' is distinct from p_owner::text
     or p_incoming->>'scope' is distinct from 'axis_portal_inbox_manager_v1' then
    raise exception 'Invalid SMS notice append';
  end if;

  insert into public.portal_inbox_thread_records
    (id, scope, owner_user_id, participant_email, thread_type, row_data, updated_at)
  values
    (p_thread_id, 'axis_portal_inbox_manager_v1', p_owner, null,
     p_thread_type, p_incoming, clock_timestamp())
  on conflict (id) do nothing;
  if found then
    return jsonb_build_object('threadId', p_thread_id, 'messageId', p_message_id);
  end if;

  select * into v_thread from public.portal_inbox_thread_records
    where id = p_thread_id for update;
  if not found or v_thread.owner_user_id is distinct from p_owner
     or v_thread.scope <> 'axis_portal_inbox_manager_v1' then
    raise exception 'SMS notice ownership mismatch';
  end if;
  v_messages := case when jsonb_typeof(v_thread.row_data->'messages') = 'array'
    then v_thread.row_data->'messages' else '[]'::jsonb end;
  if v_thread.row_data->>'rootMessageId' = p_message_id
     or exists (select 1 from jsonb_array_elements(v_messages) m where m->>'id' = p_message_id) then
    return jsonb_build_object('threadId', p_thread_id, 'messageId', p_message_id);
  end if;

  v_reopens := p_inbound and v_thread.row_data->>'folder' = 'trash';
  update public.portal_inbox_thread_records set
    row_data = v_thread.row_data || jsonb_build_object(
      'folder', case when p_inbound then 'inbox' else coalesce(v_thread.row_data->>'folder', 'inbox') end,
      'preview', p_incoming->'preview',
      'time', p_incoming->'time',
      'unread', coalesce((v_thread.row_data->>'unread')::boolean, false) or
        coalesce((p_incoming->>'unread')::boolean, false),
      'messages', v_messages || jsonb_build_array(p_message)),
    updated_at = greatest(clock_timestamp(), v_thread.updated_at + interval '1 microsecond')
    where id = p_thread_id;

  if v_reopens and coalesce(array_length(p_control_keys, 1), 0) > 0 then
    update public.manager_tour_followup_controls set
      archived = false, updated_at = clock_timestamp()
      where manager_user_id = p_owner and conversation_key = any(p_control_keys)
        and archived = true;
  end if;
  return jsonb_build_object('threadId', p_thread_id, 'messageId', p_message_id);
end;
$$;

revoke all on function public.append_manager_sms_inbox_notice(uuid,text,text,text,jsonb,jsonb,boolean,text[])
  from public, anon, authenticated;
grant execute on function public.append_manager_sms_inbox_notice(uuid,text,text,text,jsonb,jsonb,boolean,text[])
  to service_role;
