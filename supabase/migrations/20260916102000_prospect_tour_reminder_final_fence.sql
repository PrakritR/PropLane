-- Revalidate the exact prospect-tour reminder after budget and communication
-- credit awaits, immediately before the provider no-retry boundary.

create or replace function public.prospect_tour_reminder_submission_is_current(
  p_reminder_id uuid,
  p_outbox_id uuid,
  p_outbox_worker_id text,
  p_manager_user_id uuid,
  p_conversation_key text,
  p_recipient_phone_e164 text,
  p_property_id text default null
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_reminder public.prospect_sms_tour_reminders;
begin
  if p_reminder_id is null or p_outbox_id is null
    or coalesce(trim(p_outbox_worker_id),'')=''
    or p_manager_user_id is null
    or coalesce(trim(p_conversation_key),'')=''
    or coalesce(trim(p_recipient_phone_e164),'')='' then
    return false;
  end if;

  select * into v_reminder
    from public.prospect_sms_tour_reminders
    where id=p_reminder_id
    for share;
  if not found
    or v_reminder.status<>'enqueued'
    or v_reminder.manager_user_id<>p_manager_user_id
    or v_reminder.conversation_key<>trim(p_conversation_key)
    or v_reminder.recipient_phone_e164<>trim(p_recipient_phone_e164)
    or v_reminder.property_id is distinct from nullif(trim(p_property_id),'') then
    return false;
  end if;

  if not exists (
    select 1 from public.sms_outbox o
    where o.id=p_outbox_id
      and o.prospect_tour_reminder_id=v_reminder.id
      and o.manager_user_id=v_reminder.manager_user_id
      and o.conversation_key=v_reminder.conversation_key
      and o.recipient_phone=v_reminder.recipient_phone_e164
      and o.property_id is not distinct from v_reminder.property_id
      and o.status='submitting'
      and o.lease_owner=p_outbox_worker_id
      and o.provider_message_sid is null
  ) then
    return false;
  end if;

  if not exists (
    select 1 from public.prospect_sms_bursts b
    where b.id=v_reminder.burst_id
      and b.manager_user_id=v_reminder.manager_user_id
      and b.counterparty_phone_e164=v_reminder.recipient_phone_e164
      and b.revision=v_reminder.burst_revision
  ) then
    return false;
  end if;

  if not exists (
    select 1 from public.prospect_tour_scheduling_state s
    where s.id=v_reminder.scheduling_state_id
      and s.manager_user_id=v_reminder.manager_user_id
      and s.conversation_key=v_reminder.conversation_key
      and s.trusted_phone_e164=v_reminder.recipient_phone_e164
      and s.property_id=v_reminder.property_id
      and s.revision=v_reminder.scheduling_state_revision
      and s.status in ('collecting','offered')
  ) then
    return false;
  end if;

  if to_regclass('public.manager_tour_followup_controls') is not null
    and exists (
      select 1 from public.manager_tour_followup_controls c
      where c.manager_user_id=v_reminder.manager_user_id
        and c.conversation_key=v_reminder.conversation_key
        and c.archived
    ) then
    return false;
  end if;

  return true;
end; $$;

revoke execute on function public.prospect_tour_reminder_submission_is_current(uuid,uuid,text,uuid,text,text,text)
  from public, anon, authenticated;
grant execute on function public.prospect_tour_reminder_submission_is_current(uuid,uuid,text,uuid,text,text,text)
  to service_role;
