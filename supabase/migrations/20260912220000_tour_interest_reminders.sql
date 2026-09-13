-- Phone-only prospects use the same durable reminder queue as other reminders.
alter table public.portal_reminder_records add column if not exists recipient_phone text;
alter table public.portal_reminder_records alter column recipient_email drop not null;
alter table public.portal_reminder_records drop constraint if exists portal_reminder_records_recipient_check;
alter table public.portal_reminder_records add constraint portal_reminder_records_recipient_check
  check (nullif(trim(recipient_email), '') is not null or
    (kind = 'tour_interest' and coalesce(recipient_phone ~ '^\+[1-9][0-9]{7,14}$', false)));
alter table public.portal_reminder_records drop constraint if exists portal_reminder_records_kind_check;
alter table public.portal_reminder_records add constraint portal_reminder_records_kind_check check (kind in (
  'tour','tour_interest','task','service_order','work_order','booking','application','application_manager',
  'application_post_tour','lease','lease_manager','payment_manager','outgoing_payment','inspection','inspection_manager'
));
create index if not exists portal_reminder_tour_interest_thread_idx
  on public.portal_reminder_records(manager_user_id, (payload->>'conversationKey')) where kind = 'tour_interest';

-- After-response reminders use a signed timing offset in the existing queue.
alter table public.portal_reminder_records drop constraint if exists portal_reminder_records_lead_check;
alter table public.portal_reminder_records add constraint portal_reminder_records_lead_check
  check (lead_minutes between 5 and 43200 or (kind = 'tour_interest' and lead_minutes = -1440));

-- The enable cutoff is server-owned. Repairing an older outbox projection must
-- never retroactively opt a prospect into an automation enabled afterwards.
alter table public.manager_automation_settings add column if not exists tour_interest_enabled_at timestamptz;
create or replace function public.stamp_tour_interest_enabled_at()
returns trigger language plpgsql set search_path = public as $$
begin
  if coalesce(new.row_data #>> '{reminderRules,rules,tour_interest,enabled}', 'false') <> 'true' then
    new.tour_interest_enabled_at := null;
  elsif tg_op = 'INSERT' then new.tour_interest_enabled_at := clock_timestamp();
  elsif coalesce(old.row_data #>> '{reminderRules,rules,tour_interest,enabled}', 'false') <> 'true'
    or old.tour_interest_enabled_at is null then new.tour_interest_enabled_at := clock_timestamp();
  else new.tour_interest_enabled_at := old.tour_interest_enabled_at;
  end if;
  return new;
end;
$$;
drop trigger if exists stamp_tour_interest_enabled_at on public.manager_automation_settings;
create trigger stamp_tour_interest_enabled_at before insert or update on public.manager_automation_settings
  for each row execute function public.stamp_tour_interest_enabled_at();
update public.manager_automation_settings set tour_interest_enabled_at = clock_timestamp()
  where row_data #>> '{reminderRules,rules,tour_interest,enabled}' = 'true' and tour_interest_enabled_at is null;

create table if not exists public.manager_tour_followup_controls (
  manager_user_id uuid not null references auth.users(id) on delete cascade,
  conversation_key text not null,
  archived boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key(manager_user_id,conversation_key)
);
alter table public.manager_tour_followup_controls enable row level security;
revoke all on public.manager_tour_followup_controls from public, anon, authenticated;
grant all on public.manager_tour_followup_controls to service_role;

-- Both cancellation and the no-retry submission boundary take the same
-- workspace lock. A successful cancellation can never race a provider send.
create or replace function public.change_tour_interest_followup(
  p_owner uuid, p_actor uuid, p_keys text[], p_action text, p_id uuid,
  p_text text, p_send_at timestamptz, p_access_revision text, p_allowed_properties text[], p_expected_tags jsonb
) returns text language plpgsql security definer set search_path = public as $$
declare r public.portal_reminder_records; o public.sms_outbox; actual_tags jsonb;
begin
  if p_owner is null or p_actor is null or coalesce(cardinality(p_keys),0) = 0
    or p_action is null or p_action not in ('edit','cancel','archive','restore') then return 'invalid'; end if;
  perform pg_advisory_xact_lock(hashtextextended('tour-interest:' || p_owner::text, 0));
  lock table public.account_link_invites, public.manager_property_records, public.profiles in share mode;
  if p_access_revision is distinct from public.conversation_house_access_revision(p_actor) then return 'stale'; end if;
  if p_action in ('edit','cancel') and p_id is null then return 'invalid'; end if;
  if p_action in ('archive','restore') then
    lock table public.manager_sms_conversation_houses in share mode;
    select coalesce(jsonb_agg(jsonb_build_object('conversation_key',conversation_key,'property_id',property_id)
      order by conversation_key,property_id),'[]'::jsonb) into actual_tags from public.manager_sms_conversation_houses
      where manager_user_id=p_owner and conversation_key=any(p_keys);
    if actual_tags is distinct from p_expected_tags then return 'stale'; end if;
    insert into public.manager_tour_followup_controls(manager_user_id,conversation_key,archived)
      select p_owner,k,p_action='archive' from unnest(p_keys) k
      on conflict(manager_user_id,conversation_key) do update set archived=excluded.archived,updated_at=now();
    if p_action = 'restore' then return 'ok'; end if;
  end if;
  for r in select * from public.portal_reminder_records where manager_user_id=p_owner and kind='tour_interest'
    and payload->>'conversationKey'=any(p_keys) and (p_id is null or id=p_id) order by id for update
  loop
    if p_actor <> p_owner and (r.payload->>'propertyId'=any(p_allowed_properties)) is not true then
      -- Raise to roll back an archive barrier already inserted in this call.
      raise exception 'Follow-up access changed' using errcode='42501';
    end if;
    select * into o from public.sms_outbox where manager_user_id=p_owner and dedupe_key='tour-interest:'||r.id::text for update;
    if r.status='sent' and o.id is null then
      if p_action='archive' then continue; end if;
      return 'started';
    end if;
    if o.id is not null and (o.dispatch_started_at is not null or o.provider_message_sid is not null
      or o.status not in ('queued','deferred','claimed','blocked')) then
      if p_action='archive' then continue; end if;
      return 'started';
    end if;
    if p_action='edit' then
      if r.status <> 'scheduled' or o.id is not null then return 'started'; end if;
      if p_text is null or length(btrim(p_text)) not between 1 and 1600 or p_send_at is null
        or p_send_at <= now() or p_send_at < (r.payload->>'anchorIso')::timestamptz + interval '24 hours'
      then return 'invalid'; end if;
      update public.portal_reminder_records set payload=jsonb_set(payload,'{customBody}',to_jsonb(btrim(p_text))),
        send_at=p_send_at,updated_at=now() where id=r.id;
    else
      if r.status not in ('scheduled','sending','sent','cancelled') then
        if p_action='archive' then continue; end if;
        return 'started';
      end if;
      if o.id is not null then update public.sms_outbox set status='blocked',blocked_reason='tour_followup_cancelled',
        lease_owner=null,lease_expires_at=null,updated_at=now() where id=o.id; end if;
      update public.portal_reminder_records set status='cancelled',lease_owner=null,lease_expires_at=null,updated_at=now() where id=r.id;
    end if;
  end loop;
  if p_id is not null and r.id is null then return 'missing'; end if;
  return 'ok';
end;
$$;
revoke all on function public.change_tour_interest_followup(uuid,uuid,text[],text,uuid,text,timestamptz,text,text[],jsonb) from public,anon,authenticated;
grant execute on function public.change_tour_interest_followup(uuid,uuid,text[],text,uuid,text,timestamptz,text,text[],jsonb) to service_role;

create or replace function public.begin_tour_interest_submission(p_outbox_id uuid,p_worker text,p_from text)
returns boolean language plpgsql security definer set search_path = public as $$
declare o public.sms_outbox; r public.portal_reminder_records;
begin
  select * into o from public.sms_outbox where id=p_outbox_id;
  if o.id is null or o.purpose <> 'tour_interest_followup' then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended('tour-interest:' || o.manager_user_id::text, 0));
  select * into r from public.portal_reminder_records where manager_user_id=o.manager_user_id and kind='tour_interest'
    and 'tour-interest:'||id::text=o.dedupe_key for update;
  if r.id is null or r.status not in ('sending','sent') or r.send_at > now()
    or r.recipient_phone is distinct from o.recipient_phone
    or r.payload->>'conversationKey' is distinct from o.conversation_key
    or r.payload->>'propertyId' is distinct from o.property_id
    or r.payload->>'actorUserId' is distinct from o.actor_user_id::text
    or r.payload->>'customBody' is distinct from o.body then return false; end if;
  if exists(select 1 from public.manager_tour_followup_controls where manager_user_id=o.manager_user_id
    and conversation_key=o.conversation_key and archived) then return false; end if;
  if not exists(select 1 from public.manager_automation_settings where manager_user_id=o.manager_user_id
    and row_data #>> '{reminderRules,rules,tour_interest,enabled}'='true'
    and tour_interest_enabled_at <= (r.payload->>'anchorIso')::timestamptz) then return false; end if;
  if (select id::text from public.manager_sms_messages where manager_user_id=o.manager_user_id
    and resident_phone=o.recipient_phone and direction='inbound' order by created_at desc,id desc limit 1)
    is distinct from r.payload->>'inboundId' then return false; end if;
  update public.sms_outbox set status='submitting',dispatch_started_at=clock_timestamp(),provider_from_phone=p_from,updated_at=now()
    where id=p_outbox_id and status='claimed' and lease_owner=p_worker and lease_expires_at>clock_timestamp()
      and dispatch_started_at is null and provider_message_sid is null;
  return found;
end;
$$;
revoke all on function public.begin_tour_interest_submission(uuid,text,text) from public,anon,authenticated;
grant execute on function public.begin_tour_interest_submission(uuid,text,text) to service_role;

-- A no-longer-needed reminder is cancelled, not a failed delivery. Retain the
-- existing worker lease CAS and expose no new client write privileges.
create or replace function public.resolve_reminder(p_id uuid,p_worker_id text,p_status text,p_error text default null)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if p_status not in ('sent','failed','scheduled','cancelled') then raise exception 'invalid reminder resolution'; end if;
  update public.portal_reminder_records set status=p_status,
    sent_at=case when p_status='sent' then now() else sent_at end,
    last_error=p_error,lease_owner=null,lease_expires_at=null,updated_at=now()
    where id=p_id and lease_owner=p_worker_id and status='sending' returning id into v_id;
  return v_id is not null;
end;
$$;
revoke all on function public.resolve_reminder(uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.resolve_reminder(uuid,text,text,text) to service_role;
