-- Couple an accepted lease persistence with its durable notification intent.
-- External delivery remains the responsibility of the action-event worker.
create or replace function public.persist_lease_with_action_event(
  p_record jsonb,
  p_expected_updated_at timestamptz,
  p_event jsonb default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id text := nullif(trim(p_record->>'id'), '');
  v_manager uuid := nullif(p_record->>'manager_user_id', '')::uuid;
  v_existing_updated_at timestamptz;
  v_event_id uuid;
  v_delivery jsonb;
  v_event_key text;
begin
  if v_id is null or v_manager is null or jsonb_typeof(p_record->'row_data') is distinct from 'object' then
    raise exception 'invalid lease persistence record';
  end if;

  select updated_at into v_existing_updated_at
  from public.portal_lease_pipeline_records where id = v_id for update;
  if found then
    if p_expected_updated_at is null or v_existing_updated_at is distinct from p_expected_updated_at then
      return 'stale';
    end if;
    update public.portal_lease_pipeline_records set
      manager_user_id = v_manager,
      resident_user_id = nullif(p_record->>'resident_user_id', '')::uuid,
      resident_email = nullif(lower(trim(p_record->>'resident_email')), ''),
      property_id = nullif(trim(p_record->>'property_id'), ''),
      status = p_record->>'status', row_data = p_record->'row_data',
      updated_at = greatest(clock_timestamp(), v_existing_updated_at + interval '1 microsecond', (p_record->>'updated_at')::timestamptz)
    where id = v_id;
  else
    if p_expected_updated_at is not null then return 'stale'; end if;
    insert into public.portal_lease_pipeline_records
      (id, manager_user_id, resident_user_id, resident_email, property_id, status, row_data, updated_at)
    values
      (v_id, v_manager, nullif(p_record->>'resident_user_id', '')::uuid,
       nullif(lower(trim(p_record->>'resident_email')), ''), nullif(trim(p_record->>'property_id'), ''),
       p_record->>'status', p_record->'row_data', greatest(clock_timestamp(), (p_record->>'updated_at')::timestamptz))
    on conflict (id) do nothing;
    if not found then return 'stale'; end if;
  end if;

  if p_event is not null and p_event <> 'null'::jsonb then
    v_event_key := nullif(trim(p_event->>'eventKey'), '');
    if v_event_key is null or p_event->>'managerUserId' is distinct from v_manager::text
       or p_event->>'entityId' is distinct from v_id
       or nullif(trim(p_event->>'senderUserId'), '') is null
       or nullif(trim(p_event->>'senderEmail'), '') is null
       or p_event->>'occurredAt' is null
       or p_event->>'eventType' is null
       or p_event->>'eventType' not in ('lease_created','lease_sent','lease_signed_by_resident','lease_countersigned','lease_signed','lease_voided')
       or jsonb_typeof(p_event->'deliveries') is distinct from 'array' then
      raise exception 'invalid lease action event';
    end if;
    if (p_event->>'eventType' = 'lease_signed_by_resident' and not exists (
      select 1 from jsonb_array_elements(p_event->'deliveries') d where d->>'audience' = 'manager'
    )) or (p_event->>'eventType' = 'lease_signed' and not exists (
      select 1 from jsonb_array_elements(p_event->'deliveries') d where d->>'audience' = 'resident'
    )) then
      raise exception 'required lease action recipient missing';
    end if;
    insert into public.action_events
      (event_key, domain, event_type, category, manager_user_id, entity_id,
       sender_user_id, sender_email, sender_name, occurred_at, payload)
    values
      (v_event_key, 'lease', p_event->>'eventType', 'leases', v_manager, v_id,
       nullif(p_event->>'senderUserId','')::uuid, lower(trim(p_event->>'senderEmail')),
       nullif(left(trim(p_event->>'senderName'),200),''), (p_event->>'occurredAt')::timestamptz,
       coalesce(p_event->'payload','{}'::jsonb))
    on conflict (event_key) do nothing
    returning id into v_event_id;
    if v_event_id is null then
      select id into v_event_id from public.action_events
      where event_key = v_event_key and domain = 'lease' and event_type = p_event->>'eventType'
        and manager_user_id = v_manager and entity_id = v_id;
      if v_event_id is null then raise exception 'lease action event key collision'; end if;
    end if;
    for v_delivery in select value from jsonb_array_elements(p_event->'deliveries') loop
      if v_delivery->>'audience' is null
         or v_delivery->>'audience' not in ('manager','resident')
         or nullif(trim(v_delivery->>'recipientKey'),'') is null
         or coalesce(nullif(trim(v_delivery->>'recipientUserId'),''), nullif(trim(v_delivery->>'recipientEmail'),'')) is null
         or jsonb_typeof(v_delivery->'rendered') is distinct from 'object'
         or nullif(trim(v_delivery->'rendered'->>'subject'),'') is null
         or nullif(trim(v_delivery->'rendered'->>'text'),'') is null
         or (v_delivery->>'audience' = 'manager' and
             (v_delivery->>'recipientUserId' is distinct from v_manager::text or v_delivery->>'recipientKey' is distinct from v_manager::text))
         or (v_delivery->>'audience' = 'resident' and (
             (nullif(v_delivery->>'recipientUserId','') is not null and v_delivery->>'recipientUserId' is distinct from p_record->>'resident_user_id') or
             (nullif(lower(trim(v_delivery->>'recipientEmail')),'') is not null and lower(trim(v_delivery->>'recipientEmail')) is distinct from lower(trim(p_record->>'resident_email'))) or
             v_delivery->>'recipientKey' is distinct from coalesce(nullif(p_record->>'resident_user_id',''), lower(trim(p_record->>'resident_email')))
         )) then
        raise exception 'invalid lease action delivery';
      end if;
      insert into public.action_event_deliveries
        (event_id, audience, recipient_key, recipient_user_id, recipient_email,
         status, next_attempt_at, rendered)
      values
        (v_event_id, v_delivery->>'audience', left(v_delivery->>'recipientKey',320),
         nullif(v_delivery->>'recipientUserId','')::uuid,
         nullif(lower(trim(v_delivery->>'recipientEmail')),''), 'pending', now(), v_delivery->'rendered')
      on conflict (event_id, audience, recipient_key) do nothing;
    end loop;
  end if;
  return 'persisted';
end;
$$;

alter table public.action_event_deliveries
  drop constraint if exists work_order_event_deliveries_status_check,
  add constraint work_order_event_deliveries_status_check
    check (status in ('pending', 'delivered', 'submitted', 'failed', 'email_failed', 'sms_failed', 'channels_failed', 'deferred', 'digested'));

drop index if exists public.work_order_event_deliveries_retry_idx;
create index work_order_event_deliveries_retry_idx
  on public.action_event_deliveries (status, next_attempt_at)
  where status in ('pending', 'failed', 'email_failed', 'sms_failed', 'channels_failed', 'deferred');

revoke all on function public.persist_lease_with_action_event(jsonb,timestamptz,jsonb) from public, anon, authenticated;
grant execute on function public.persist_lease_with_action_event(jsonb,timestamptz,jsonb) to service_role;

comment on function public.persist_lease_with_action_event(jsonb,timestamptz,jsonb) is
  'Service-only CAS lease persistence plus durable action-event enqueue. Performs no external delivery.';
