-- Authenticated, non-delivering SMS test identity. Live SMS remains phone-bound;
-- a test row carries an authenticated user id instead and the two forms are
-- mutually exclusive at the database boundary.

alter table public.prospect_sms_bursts
  add column if not exists test_actor_user_id uuid references auth.users(id) on delete cascade,
  add column if not exists test_session_id uuid references public.agent_sessions(id) on delete cascade,
  add column if not exists identity_kind text not null default 'live_phone';

alter table public.prospect_sms_bursts
  alter column counterparty_phone_e164 drop not null;

alter table public.prospect_sms_bursts
  drop constraint if exists prospect_sms_bursts_channel_check,
  drop constraint if exists prospect_sms_bursts_reply_transport_check,
  drop constraint if exists prospect_sms_bursts_identity_kind_check,
  drop constraint if exists prospect_sms_bursts_identity_xor_check;

alter table public.prospect_sms_bursts
  add constraint prospect_sms_bursts_channel_check
    check (channel in ('sms','voice','test')),
  add constraint prospect_sms_bursts_reply_transport_check
    check (reply_transport in ('twilio','claw','in_app_test')),
  add constraint prospect_sms_bursts_identity_kind_check
    check (identity_kind in ('live_phone','authenticated_test')),
  add constraint prospect_sms_bursts_identity_xor_check check (
    (
      identity_kind='live_phone'
      and coalesce(trim(counterparty_phone_e164),'')<>''
      and test_actor_user_id is null
      and test_session_id is null
      and channel in ('sms','voice')
      and reply_transport in ('twilio','claw')
    ) or (
      identity_kind='authenticated_test'
      and counterparty_phone_e164 is null
      and test_actor_user_id is not null
      and test_session_id is not null
      and channel='test'
      and reply_transport='in_app_test'
      and reply_from_number is null
    )
  );

drop index if exists public.prospect_sms_bursts_test_actor_uidx;
create unique index if not exists prospect_sms_bursts_test_session_uidx
  on public.prospect_sms_bursts(manager_user_id,test_session_id,counterparty_role,channel)
  where identity_kind='authenticated_test';

alter table public.prospect_sms_ingress
  add column if not exists test_actor_user_id uuid references auth.users(id) on delete cascade,
  add column if not exists test_session_id uuid references public.agent_sessions(id) on delete cascade;
alter table public.prospect_sms_ingress
  drop constraint if exists prospect_sms_ingress_channel_check,
  drop constraint if exists prospect_sms_ingress_test_identity_check;
alter table public.prospect_sms_ingress
  add constraint prospect_sms_ingress_channel_check check (channel in ('twilio','claw','in_app_test')),
  add constraint prospect_sms_ingress_test_identity_check check (
    (channel='in_app_test' and test_actor_user_id is not null and test_session_id is not null)
    or (channel in ('twilio','claw') and test_actor_user_id is null and test_session_id is null)
  );

alter table public.prospect_tour_scheduling_state
  add column if not exists test_actor_user_id uuid references auth.users(id) on delete cascade,
  add column if not exists test_session_id uuid references public.agent_sessions(id) on delete cascade,
  add column if not exists identity_kind text not null default 'live_phone';
alter table public.prospect_tour_scheduling_state
  alter column trusted_phone_e164 drop not null;
alter table public.prospect_tour_scheduling_state
  drop constraint if exists prospect_tour_scheduling_state_identity_kind_check,
  drop constraint if exists prospect_tour_scheduling_state_identity_xor_check;
alter table public.prospect_tour_scheduling_state
  add constraint prospect_tour_scheduling_state_identity_kind_check
    check (identity_kind in ('live_phone','authenticated_test')),
  add constraint prospect_tour_scheduling_state_identity_xor_check check (
    (identity_kind='live_phone' and coalesce(trim(trusted_phone_e164),'')<>'' and test_actor_user_id is null and test_session_id is null)
    or (identity_kind='authenticated_test' and trusted_phone_e164 is null and test_actor_user_id is not null and test_session_id is not null)
  );

alter table public.prospect_tour_bookings
  add column if not exists test_actor_user_id uuid references auth.users(id) on delete cascade,
  add column if not exists test_session_id uuid references public.agent_sessions(id) on delete cascade;
alter table public.prospect_tour_bookings
  drop constraint if exists prospect_tour_bookings_confirmation_status_check;
alter table public.prospect_tour_bookings
  add constraint prospect_tour_bookings_confirmation_status_check
    check (confirmation_status in ('pending','prepared','submitted','blocked','captured'));

alter table public.agent_sessions
  add column if not exists test_actor_user_id uuid references auth.users(id) on delete cascade,
  add column if not exists sms_test_manager_user_id uuid references auth.users(id) on delete cascade,
  add column if not exists sms_test_mode text,
  add column if not exists sms_test_target_listing_id text;
alter table public.agent_sessions
  drop constraint if exists agent_sessions_sms_test_identity_check;
alter table public.agent_sessions
  add constraint agent_sessions_sms_test_identity_check check (
    (test_actor_user_id is null and sms_test_manager_user_id is null and sms_test_mode is null and sms_test_target_listing_id is null)
    or (
      test_actor_user_id is not null
      and sms_test_manager_user_id is not null
      and sms_test_mode is not null
      and sms_test_mode in ('manager','prospect','resident')
      and user_id is not null
      and user_id=test_actor_user_id
      and landlord_id=sms_test_manager_user_id
      and kind = (case sms_test_mode
        when 'manager' then 'manager_sms_test:' || sms_test_manager_user_id::text
        when 'prospect' then 'leasing_sms_test:' || sms_test_manager_user_id::text || ':' || sms_test_target_listing_id
        when 'resident' then 'resident_sms_test:' || sms_test_manager_user_id::text || ':' || sms_test_target_listing_id
      end)
      and ((sms_test_mode='manager' and sms_test_target_listing_id is null)
        or (sms_test_mode in ('prospect','resident') and coalesce(trim(sms_test_target_listing_id),'')<>''))
      and vendor_phone_e164 is null
    )
  );
drop index if exists public.agent_sessions_sms_test_identity_uidx;

alter table public.sms_outbox
  drop constraint if exists sms_outbox_transport_check;
alter table public.sms_outbox
  add constraint sms_outbox_transport_check check (transport in ('twilio','claw','in_app_test'));

-- A test message enters the same revisioned burst machinery as carrier SMS,
-- but identity is the authenticated actor and no routable address is stored.
create or replace function public.record_authenticated_sms_test_ingress(
  p_source_message_id text,
  p_manager_user_id uuid,
  p_test_actor_user_id uuid,
  p_test_session_id uuid,
  p_body text
) returns table (burst_id uuid, revision integer, inserted boolean, due_at timestamptz)
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_burst public.prospect_sms_bursts;
  v_inserted integer;
  v_revision integer;
begin
  if coalesce(trim(p_source_message_id),'')='' or p_manager_user_id is null
    or p_test_actor_user_id is null or p_test_session_id is null or coalesce(trim(p_body),'')='' then
    raise exception 'invalid authenticated sms test ingress';
  end if;
  if not exists(select 1 from public.agent_sessions s where s.id=p_test_session_id
    and s.user_id=p_test_actor_user_id and s.test_actor_user_id=p_test_actor_user_id
    and s.landlord_id=p_manager_user_id and s.sms_test_manager_user_id=p_manager_user_id
    and s.sms_test_mode='prospect' and s.status='active') then
    raise exception 'invalid authenticated sms test session';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    p_manager_user_id::text || ':sms-test:' || p_test_session_id::text,0
  ));
  select b.* into v_burst from public.prospect_sms_ingress i
    join public.prospect_sms_bursts b on b.id=i.burst_id
    where i.source_message_id=p_source_message_id and i.channel='in_app_test'
      and i.test_actor_user_id=p_test_actor_user_id and i.manager_user_id=p_manager_user_id
      and i.test_session_id=p_test_session_id
      and b.manager_user_id=p_manager_user_id;
  if found then
    return query select v_burst.id,v_burst.revision,false,v_burst.due_at;
    return;
  end if;
  select * into v_burst from public.prospect_sms_bursts
    where manager_user_id=p_manager_user_id and test_actor_user_id=p_test_actor_user_id
      and test_session_id=p_test_session_id
      and counterparty_role='prospect' and channel='test' and identity_kind='authenticated_test'
    for update;
  if not found then
    insert into public.prospect_sms_bursts(
      manager_user_id,counterparty_phone_e164,test_actor_user_id,test_session_id,identity_kind,
      counterparty_role,channel,reply_from_number,reply_transport,due_at
    ) values (
      p_manager_user_id,null,p_test_actor_user_id,p_test_session_id,'authenticated_test',
      'prospect','test',null,'in_app_test',now()
    ) returning * into v_burst;
  end if;
  update public.prospect_sms_bursts set
    revision=v_burst.revision+1,
    status=case when status='generating' and lease_expires_at>now() then 'generating' else 'queued' end,
    due_at=now(),
    lease_owner=case when status='generating' and lease_expires_at>now() then lease_owner else null end,
    lease_expires_at=case when status='generating' and lease_expires_at>now() then lease_expires_at else null end,
    queue_job_id=null,published_at=null,candidate_body=null,candidate_context=null,
    candidate_shadow_snapshot=null,outbox_id=null,updated_at=now()
    where id=v_burst.id returning * into v_burst;
  v_revision:=v_burst.revision;
  insert into public.prospect_sms_ingress(
    source_message_id,burst_id,manager_user_id,channel,burst_revision,body,test_actor_user_id,test_session_id
  ) values (
    p_source_message_id,v_burst.id,p_manager_user_id,'in_app_test',v_revision,left(p_body,2000),p_test_actor_user_id,p_test_session_id
  ) on conflict do nothing;
  get diagnostics v_inserted=row_count;
  if v_inserted=0 then raise exception 'authenticated sms test ingress unexpectedly conflicted'; end if;
  return query select v_burst.id,v_revision,true,v_burst.due_at;
end; $$;

revoke execute on function public.record_authenticated_sms_test_ingress(text,uuid,uuid,uuid,text)
  from public,anon,authenticated;
grant execute on function public.record_authenticated_sms_test_ingress(text,uuid,uuid,uuid,text)
  to service_role;

create or replace function public.claim_prospect_burst_identity_core(
  p_burst_id uuid,p_revision integer,p_worker_id text,p_lease_seconds integer,
  p_identity_kind text,p_test_actor_user_id uuid,p_test_session_id uuid
) returns table(claimed boolean,source_ids jsonb)
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_ids jsonb;
begin
  select coalesce(jsonb_agg(i.source_message_id order by i.received_at,i.source_message_id),'[]'::jsonb) into v_ids
    from public.prospect_sms_ingress i
    where i.burst_id=p_burst_id and i.burst_revision<=p_revision
      and i.burst_revision>(select handled_revision from public.prospect_sms_bursts where id=p_burst_id)
      and ((p_identity_kind='live_phone' and i.test_actor_user_id is null)
        or (p_identity_kind='authenticated_test' and i.test_actor_user_id=p_test_actor_user_id
          and i.test_session_id=p_test_session_id));
  update public.prospect_sms_bursts set status='generating',lease_owner=p_worker_id,
    lease_expires_at=now()+make_interval(secs=>greatest(30,least(p_lease_seconds,300))),
    consumed_source_ids=v_ids,updated_at=now()
  where id=p_burst_id and revision=p_revision and due_at<=now() and identity_kind=p_identity_kind
    and ((p_identity_kind='live_phone' and test_actor_user_id is null)
      or (p_identity_kind='authenticated_test' and test_actor_user_id=p_test_actor_user_id
        and test_session_id=p_test_session_id))
    and (status in ('queued','failed') or (status='generating' and lease_expires_at<=now()))
  returning true,v_ids into claimed,source_ids;
  return next;
end; $$;

create or replace function public.claim_prospect_sms_burst(
  p_burst_id uuid,p_revision integer,p_worker_id text,p_lease_seconds integer default 120
) returns table(claimed boolean,source_ids jsonb)
language sql security definer set search_path=public,pg_temp as $$
  select * from public.claim_prospect_burst_identity_core(
    p_burst_id,p_revision,p_worker_id,p_lease_seconds,'live_phone',null,null
  );
$$;

create or replace function public.claim_authenticated_sms_test_burst(
  p_burst_id uuid,p_revision integer,p_worker_id text,p_test_actor_user_id uuid,p_test_session_id uuid,
  p_lease_seconds integer default 120
) returns table(claimed boolean,source_ids jsonb)
language sql security definer set search_path=public,pg_temp as $$
  select * from public.claim_prospect_burst_identity_core(
    p_burst_id,p_revision,p_worker_id,p_lease_seconds,'authenticated_test',p_test_actor_user_id,p_test_session_id
  );
$$;

revoke execute on function public.claim_prospect_burst_identity_core(uuid,integer,text,integer,text,uuid,uuid)
  from public,anon,authenticated;
revoke execute on function public.claim_prospect_sms_burst(uuid,integer,text,integer)
  from public,anon,authenticated;
grant execute on function public.claim_prospect_sms_burst(uuid,integer,text,integer) to service_role;
revoke execute on function public.claim_authenticated_sms_test_burst(uuid,integer,text,uuid,uuid,integer)
  from public,anon,authenticated;
grant execute on function public.claim_authenticated_sms_test_burst(uuid,integer,text,uuid,uuid,integer) to service_role;

create or replace function public.authorize_authenticated_sms_test_inline_action(
  p_burst_id uuid,p_revision integer,p_worker_id text,p_tool_call_id text,p_tool_name text,
  p_test_actor_user_id uuid,p_test_session_id uuid
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform 1 from public.prospect_sms_bursts where id=p_burst_id and revision=p_revision
    and identity_kind='authenticated_test' and test_actor_user_id=p_test_actor_user_id
    and test_session_id=p_test_session_id
    and counterparty_phone_e164 is null and status='generating'
    and lease_owner=p_worker_id and lease_expires_at>now();
  if not found then return false; end if;
  return public.authorize_prospect_sms_inline_action(
    p_burst_id,p_revision,p_worker_id,p_tool_call_id,p_tool_name
  );
end; $$;

create or replace function public.release_authenticated_sms_test_inline_action(
  p_burst_id uuid,p_revision integer,p_worker_id text,p_tool_call_id text,
  p_test_actor_user_id uuid,p_test_session_id uuid
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform 1 from public.prospect_sms_bursts where id=p_burst_id and revision=p_revision
    and identity_kind='authenticated_test' and test_actor_user_id=p_test_actor_user_id
    and test_session_id=p_test_session_id
    and counterparty_phone_e164 is null and status='generating'
    and lease_owner=p_worker_id and lease_expires_at>now();
  if not found then return false; end if;
  return public.release_prospect_sms_inline_action(p_burst_id,p_revision,p_worker_id,p_tool_call_id);
end; $$;

revoke execute on function public.authorize_authenticated_sms_test_inline_action(uuid,integer,text,text,text,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.authorize_authenticated_sms_test_inline_action(uuid,integer,text,text,text,uuid,uuid)
  to service_role;
revoke execute on function public.release_authenticated_sms_test_inline_action(uuid,integer,text,text,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.release_authenticated_sms_test_inline_action(uuid,integer,text,text,uuid,uuid)
  to service_role;

create or replace function public.complete_authenticated_sms_test_burst(
  p_burst_id uuid,
  p_revision integer,
  p_worker_id text,
  p_test_actor_user_id uuid,
  p_test_session_id uuid,
  p_candidate_body text,
  p_candidate_context jsonb
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_id uuid;
begin
  update public.prospect_sms_bursts set
    status='dispatched',handled_revision=p_revision,candidate_body=left(p_candidate_body,2000),
    history_snapshot=coalesce(p_candidate_context,'[]'::jsonb),candidate_context=null,
    candidate_shadow_snapshot=null,outbox_id=null,lease_owner=null,lease_expires_at=null,updated_at=now()
  where id=p_burst_id and revision=p_revision and status='generating'
    and lease_owner=p_worker_id and lease_expires_at>now()
    and identity_kind='authenticated_test' and test_actor_user_id=p_test_actor_user_id
    and test_session_id=p_test_session_id
    and reply_transport='in_app_test'
  returning id into v_id;
  return v_id is not null;
end; $$;

revoke execute on function public.complete_authenticated_sms_test_burst(uuid,integer,text,uuid,uuid,text,jsonb)
  from public,anon,authenticated;
grant execute on function public.complete_authenticated_sms_test_burst(uuid,integer,text,uuid,uuid,text,jsonb)
  to service_role;

create or replace function public.prepare_prospect_tour_offer_identity_core(
  p_manager_user_id uuid,p_trusted_phone_e164 text,p_test_actor_user_id uuid,p_identity_kind text,
  p_conversation_key text,p_property_id text,
  p_contact_name text,p_contact_email text,p_offer jsonb,p_burst_id uuid,p_burst_revision integer,p_worker_id text
) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_state public.prospect_tour_scheduling_state;
  v_burst public.prospect_sms_bursts;
begin
  select * into v_burst from public.prospect_sms_bursts
    where id=p_burst_id and revision=p_burst_revision and manager_user_id=p_manager_user_id
      and identity_kind=p_identity_kind
      and (
        (p_identity_kind='live_phone' and counterparty_phone_e164=p_trusted_phone_e164 and test_actor_user_id is null)
        or (p_identity_kind='authenticated_test' and counterparty_phone_e164 is null and test_actor_user_id=p_test_actor_user_id)
      )
      and status='generating' and lease_owner=p_worker_id and lease_expires_at>now()
    for update;
  if not found then return jsonb_build_object('ok',false,'reason','stale_offer'); end if;
  if not (
      (p_identity_kind='live_phone' and coalesce(trim(p_trusted_phone_e164),'')<>'' and p_test_actor_user_id is null)
      or (p_identity_kind='authenticated_test' and p_trusted_phone_e164 is null and p_test_actor_user_id is not null)
    ) or coalesce(trim(p_conversation_key),'')=''
    or coalesce(trim(p_property_id),'')='' or coalesce(trim(p_contact_name),'')=''
    or p_offer->>'hostUserId' is distinct from p_manager_user_id::text
    or p_offer->>'policy' is distinct from 'published_only'
    or coalesce(p_offer->>'slotKey','')='' or coalesce(p_offer->>'start','')=''
    or coalesce(p_offer->>'end','')='' then
    return jsonb_build_object('ok',false,'reason','invalid_offer');
  end if;
  insert into public.prospect_tour_scheduling_state(
    manager_user_id,conversation_key,property_id,contact_name,contact_email,
    trusted_phone_e164,test_actor_user_id,test_session_id,identity_kind,selected_offer,status,last_inbound_at
  ) values(
    p_manager_user_id,p_conversation_key,p_property_id,trim(p_contact_name),nullif(trim(p_contact_email),''),
    nullif(trim(p_trusted_phone_e164),''),p_test_actor_user_id,v_burst.test_session_id,p_identity_kind,p_offer,'offered',now()
  ) on conflict(manager_user_id,conversation_key,property_id) do update set
    contact_name=excluded.contact_name,
    contact_email=coalesce(excluded.contact_email,public.prospect_tour_scheduling_state.contact_email),
    trusted_phone_e164=excluded.trusted_phone_e164,test_actor_user_id=excluded.test_actor_user_id,
    test_session_id=excluded.test_session_id,identity_kind=excluded.identity_kind,
    selected_offer=excluded.selected_offer,status='offered',
    revision=public.prospect_tour_scheduling_state.revision,last_inbound_at=now(),updated_at=now()
  where public.prospect_tour_scheduling_state.status in ('collecting','offered')
    and public.prospect_tour_scheduling_state.identity_kind=p_identity_kind
    and (
      (p_identity_kind='live_phone' and public.prospect_tour_scheduling_state.trusted_phone_e164=p_trusted_phone_e164
        and public.prospect_tour_scheduling_state.test_actor_user_id is null)
      or (p_identity_kind='authenticated_test' and public.prospect_tour_scheduling_state.trusted_phone_e164 is null
        and public.prospect_tour_scheduling_state.test_actor_user_id=p_test_actor_user_id
        and public.prospect_tour_scheduling_state.test_session_id=v_burst.test_session_id)
    )
  returning * into v_state;
  if not found then return jsonb_build_object('ok',false,'reason','terminal_scheduling_state'); end if;
  return jsonb_build_object('ok',true,'stateId',v_state.id,'stateRevision',v_state.revision);
end; $$;

revoke execute on function public.prepare_prospect_tour_offer_identity_core(uuid,text,uuid,text,text,text,text,text,jsonb,uuid,integer,text)
  from public,anon,authenticated;

create or replace function public.prepare_prospect_sms_tour_offer(
  p_manager_user_id uuid,p_conversation_key text,p_property_id text,p_trusted_phone_e164 text,
  p_contact_name text,p_contact_email text,p_offer jsonb,p_burst_id uuid,p_burst_revision integer,p_worker_id text
) returns jsonb language sql security definer set search_path=public,pg_temp as $$
  select public.prepare_prospect_tour_offer_identity_core(
    p_manager_user_id,p_trusted_phone_e164,null,'live_phone',p_conversation_key,p_property_id,
    p_contact_name,p_contact_email,p_offer,p_burst_id,p_burst_revision,p_worker_id
  );
$$;

create or replace function public.prepare_authenticated_sms_test_tour_offer(
  p_manager_user_id uuid,p_test_actor_user_id uuid,p_conversation_key text,p_property_id text,
  p_contact_name text,p_contact_email text,p_offer jsonb,p_burst_id uuid,p_burst_revision integer,p_worker_id text
) returns jsonb language sql security definer set search_path=public,pg_temp as $$
  select public.prepare_prospect_tour_offer_identity_core(
    p_manager_user_id,null,p_test_actor_user_id,'authenticated_test',p_conversation_key,p_property_id,
    p_contact_name,p_contact_email,p_offer,p_burst_id,p_burst_revision,p_worker_id
  );
$$;

revoke execute on function public.prepare_prospect_sms_tour_offer(uuid,text,text,text,text,text,jsonb,uuid,integer,text)
  from public,anon,authenticated;
grant execute on function public.prepare_prospect_sms_tour_offer(uuid,text,text,text,text,text,jsonb,uuid,integer,text)
  to service_role;
revoke execute on function public.prepare_authenticated_sms_test_tour_offer(uuid,uuid,text,text,text,text,jsonb,uuid,integer,text)
  from public,anon,authenticated;
grant execute on function public.prepare_authenticated_sms_test_tour_offer(uuid,uuid,text,text,text,text,jsonb,uuid,integer,text)
  to service_role;

create or replace function public.confirm_prospect_tour_offer_identity_core(
  p_manager_user_id uuid,p_trusted_phone_e164 text,p_test_actor_user_id uuid,p_identity_kind text,
  p_conversation_key text,p_property_id text,
  p_contact_name text,p_contact_email text,p_offer jsonb,p_event jsonb,p_idempotency_key text,
  p_burst_id uuid,p_burst_revision integer,p_agreement_source_message_id text,
  p_claimed_source_ids text[],p_worker_id text
) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_state public.prospect_tour_scheduling_state;
  v_existing public.prospect_tour_bookings;
  v_mutation jsonb;
  v_history jsonb;
  v_confirmation_body text;
  v_burst public.prospect_sms_bursts;
  v_ingress_ids text[];
begin
  if p_manager_user_id is null or not (
      (p_identity_kind='live_phone' and coalesce(trim(p_trusted_phone_e164),'')<>'' and p_test_actor_user_id is null)
      or (p_identity_kind='authenticated_test' and p_trusted_phone_e164 is null and p_test_actor_user_id is not null)
    )
    or coalesce(trim(p_conversation_key),'')='' or coalesce(trim(p_property_id),'')=''
    or coalesce(trim(p_contact_name),'')='' or coalesce(trim(p_idempotency_key),'')=''
    or p_burst_id is null or p_burst_revision is null
    or coalesce(trim(p_agreement_source_message_id),'')='' or coalesce(trim(p_worker_id),'')=''
    or coalesce(cardinality(p_claimed_source_ids),0)=0 then
    raise exception 'invalid authenticated sms test tour booking';
  end if;
  select * into v_existing from public.prospect_tour_bookings
    where idempotency_key=p_idempotency_key and manager_user_id=p_manager_user_id
      and burst_id=p_burst_id and burst_revision=p_burst_revision
      and (
        (p_identity_kind='live_phone' and test_actor_user_id is null)
        or (p_identity_kind='authenticated_test' and test_actor_user_id=p_test_actor_user_id)
      ) for update;
  if found then
    if v_existing.status<>'confirmed' then return jsonb_build_object('ok',false,'reason','booking_no_longer_confirmed'); end if;
    return jsonb_build_object('ok',true,'idempotent',true,'plannedEventId',v_existing.planned_event_id,'status',v_existing.status);
  end if;
  select * into v_burst from public.prospect_sms_bursts where id=p_burst_id
    and manager_user_id=p_manager_user_id and identity_kind=p_identity_kind
    and (
      (p_identity_kind='live_phone' and counterparty_phone_e164=p_trusted_phone_e164 and test_actor_user_id is null)
      or (p_identity_kind='authenticated_test' and counterparty_phone_e164 is null and test_actor_user_id=p_test_actor_user_id)
    )
    and status='generating' and lease_owner=p_worker_id and lease_expires_at>now() for update;
  if not found or v_burst.revision<>p_burst_revision
    or jsonb_typeof(v_burst.consumed_source_ids) is distinct from 'array'
    or v_burst.consumed_source_ids is distinct from to_jsonb(p_claimed_source_ids)
    or cardinality(p_claimed_source_ids)<>(select count(distinct source_id) from unnest(p_claimed_source_ids) source_id)
    or not (p_agreement_source_message_id=any(p_claimed_source_ids)) then
    return jsonb_build_object('ok',false,'reason','stale_agreement');
  end if;
  select array_agg(i.source_message_id order by i.received_at,i.source_message_id) into v_ingress_ids
    from public.prospect_sms_ingress i where i.burst_id=p_burst_id
      and ((p_identity_kind='live_phone' and i.test_actor_user_id is null)
        or (p_identity_kind='authenticated_test' and i.test_actor_user_id=p_test_actor_user_id
          and i.test_session_id=v_burst.test_session_id))
      and i.source_message_id=any(p_claimed_source_ids);
  if v_ingress_ids is distinct from p_claimed_source_ids then
    return jsonb_build_object('ok',false,'reason','stale_agreement');
  end if;
  if p_event->>'kind' is distinct from 'tour'
    or p_event->>'managerUserId' is distinct from p_manager_user_id::text
    or p_event->>'adminUserId' is distinct from p_manager_user_id::text
    or p_event->>'propertyId' is distinct from p_property_id
    or p_event->>'slotKey' is distinct from p_offer->>'slotKey'
    or p_event->>'start' is distinct from p_offer->>'start'
    or p_event->>'end' is distinct from p_offer->>'end'
    or p_offer->>'hostUserId' is distinct from p_manager_user_id::text
    or p_offer->>'policy' is distinct from 'published_only' then
    return jsonb_build_object('ok',false,'reason','invalid_offer');
  end if;
  select * into v_state from public.prospect_tour_scheduling_state
    where manager_user_id=p_manager_user_id and conversation_key=p_conversation_key and property_id=p_property_id
      and identity_kind=p_identity_kind
      and ((p_identity_kind='live_phone' and trusted_phone_e164=p_trusted_phone_e164 and test_actor_user_id is null)
        or (p_identity_kind='authenticated_test' and trusted_phone_e164 is null and test_actor_user_id=p_test_actor_user_id
          and test_session_id=v_burst.test_session_id))
      and status='offered' and selected_offer->>'slotKey'=p_offer->>'slotKey'
      and selected_offer->>'start'=p_offer->>'start' and selected_offer->>'end'=p_offer->>'end'
      and selected_offer->>'hostUserId'=p_offer->>'hostUserId' for update;
  if not found then return jsonb_build_object('ok',false,'reason','offer_not_prepared'); end if;
  v_history:=v_burst.history_snapshot;
  if not exists (select 1 from jsonb_array_elements(coalesce(v_history,'[]'::jsonb)) fact
    where fact->>'tool'='prepare_prospect_tour_confirmation' and fact->'input'->>'propertyId'=p_property_id
      and fact->'output'->'preparedOffer'->>'slotKey'=p_offer->>'slotKey'
      and fact->'output'->'preparedOffer'->>'start'=p_offer->>'start'
      and fact->'output'->'preparedOffer'->>'end'=p_offer->>'end'
      and fact->'output'->'preparedOffer'->>'hostUserId'=p_offer->>'hostUserId') then
    return jsonb_build_object('ok',false,'reason','offer_not_submitted');
  end if;
  v_mutation:=public.mutate_confirmed_tour_schedule('append',p_event);
  if coalesce((v_mutation->>'ok')::boolean,false) is not true then return v_mutation; end if;
  v_confirmation_body:='Tour confirmed for '||coalesce(nullif(trim(p_offer->>'label'),''),p_offer->>'start')||'.';
  if p_identity_kind='authenticated_test' then
    insert into public.prospect_tour_bookings(
      manager_user_id,scheduling_state_id,idempotency_key,planned_event_id,burst_id,burst_revision,
      offer_snapshot,event_snapshot,confirmation_body,confirmation_status,manager_notification_status,
      calendar_sync_status,test_actor_user_id,test_session_id
    ) values(
      p_manager_user_id,v_state.id,p_idempotency_key,p_event->>'id',p_burst_id,p_burst_revision,
      p_offer,p_event,v_confirmation_body,'captured','suppressed','skipped',p_test_actor_user_id,v_burst.test_session_id
    );
  else
    insert into public.prospect_tour_bookings(
      manager_user_id,scheduling_state_id,idempotency_key,planned_event_id,burst_id,burst_revision,
      offer_snapshot,event_snapshot,confirmation_body
    ) values(
      p_manager_user_id,v_state.id,p_idempotency_key,p_event->>'id',p_burst_id,p_burst_revision,
      p_offer,p_event,v_confirmation_body
    );
  end if;
  update public.prospect_tour_scheduling_state set booking_event_id=p_event->>'id',status='booked',updated_at=now()
    where id=v_state.id;
  return jsonb_build_object('ok',true,'idempotent',false,'plannedEventId',p_event->>'id','status','confirmed');
end; $$;

revoke execute on function public.confirm_prospect_tour_offer_identity_core(uuid,text,uuid,text,text,text,text,text,jsonb,jsonb,text,uuid,integer,text,text[],text)
  from public,anon,authenticated;

create or replace function public.confirm_prospect_sms_tour_offer(
  p_manager_user_id uuid,p_conversation_key text,p_property_id text,p_trusted_phone_e164 text,
  p_contact_name text,p_contact_email text,p_offer jsonb,p_event jsonb,p_idempotency_key text,
  p_burst_id uuid,p_burst_revision integer,p_agreement_source_message_id text,p_claimed_source_ids text[],p_worker_id text
) returns jsonb language sql security definer set search_path=public,pg_temp as $$
  select public.confirm_prospect_tour_offer_identity_core(
    p_manager_user_id,p_trusted_phone_e164,null,'live_phone',p_conversation_key,p_property_id,
    p_contact_name,p_contact_email,p_offer,p_event,p_idempotency_key,p_burst_id,p_burst_revision,
    p_agreement_source_message_id,p_claimed_source_ids,p_worker_id
  );
$$;

create or replace function public.confirm_authenticated_sms_test_tour_offer(
  p_manager_user_id uuid,p_test_actor_user_id uuid,p_conversation_key text,p_property_id text,
  p_contact_name text,p_contact_email text,p_offer jsonb,p_event jsonb,p_idempotency_key text,
  p_burst_id uuid,p_burst_revision integer,p_agreement_source_message_id text,p_claimed_source_ids text[],p_worker_id text
) returns jsonb language sql security definer set search_path=public,pg_temp as $$
  select public.confirm_prospect_tour_offer_identity_core(
    p_manager_user_id,null,p_test_actor_user_id,'authenticated_test',p_conversation_key,p_property_id,
    p_contact_name,p_contact_email,p_offer,p_event,p_idempotency_key,p_burst_id,p_burst_revision,
    p_agreement_source_message_id,p_claimed_source_ids,p_worker_id
  );
$$;

revoke execute on function public.confirm_prospect_sms_tour_offer(uuid,text,text,text,text,text,jsonb,jsonb,text,uuid,integer,text,text[],text)
  from public,anon,authenticated;
grant execute on function public.confirm_prospect_sms_tour_offer(uuid,text,text,text,text,text,jsonb,jsonb,text,uuid,integer,text,text[],text)
  to service_role;
revoke execute on function public.confirm_authenticated_sms_test_tour_offer(uuid,uuid,text,text,text,text,jsonb,jsonb,text,uuid,integer,text,text[],text)
  from public,anon,authenticated;
grant execute on function public.confirm_authenticated_sms_test_tour_offer(uuid,uuid,text,text,text,text,jsonb,jsonb,text,uuid,integer,text,text[],text)
  to service_role;
