-- PropLane SMS control plane.
--
-- Additive only: existing manager number and delivery tables remain readable
-- while sends move behind a durable, owner-scoped dispatcher. All objects in
-- this migration are service-role only. The singleton runtime switch is seeded
-- paused so applying the migration cannot purchase a number or send a message.

alter table public.manager_sms_numbers
  add column if not exists provision_request_id uuid,
  add column if not exists attachment_state text not null default 'not_attached',
  add column if not exists attached_at timestamptz,
  add column if not exists number_registration_state text not null default 'not_submitted',
  add column if not exists campaign_sid text,
  add column if not exists registration_submitted_at timestamptz,
  add column if not exists last_provider_event_at timestamptz,
  add column if not exists provider_reconciled_at timestamptz,
  add column if not exists grace_started_at timestamptz,
  add column if not exists grace_expires_at timestamptz,
  add column if not exists quarantined_at timestamptz,
  add column if not exists quarantine_reason text,
  add column if not exists detach_confirmed_at timestamptz,
  add column if not exists deregistration_confirmed_at timestamptz,
  add column if not exists provider_release_confirmed_at timestamptz;

do $$ begin
  alter table public.manager_sms_numbers
    add constraint manager_sms_numbers_attachment_state_check
    check (attachment_state in ('not_attached', 'attaching', 'attached', 'failed'));
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.manager_sms_numbers
    add constraint manager_sms_numbers_number_registration_state_check
    check (number_registration_state in (
      'not_submitted', 'pending', 'registered', 'failed',
      'deregistering', 'deregistered'
    ));
exception when duplicate_object then null;
end $$;

create unique index if not exists manager_sms_numbers_phone_sid_uniq
  on public.manager_sms_numbers (phone_number_sid)
  where phone_number_sid is not null and provision_state <> 'released';

create table if not exists public.sms_runtime_config (
  singleton boolean primary key default true check (singleton),
  mode text not null default 'paused'
    check (mode in ('paused', 'allowlisted_self_service', 'automatic')),
  pilot_manager_user_ids uuid[] not null default '{}',
  campaign_daily_segment_limit integer not null default 500
    check (campaign_daily_segment_limit > 0),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

insert into public.sms_runtime_config (singleton, mode)
values (true, 'paused')
on conflict (singleton) do nothing;

create table if not exists public.sms_manager_entitlements (
  manager_user_id uuid primary key references auth.users (id) on delete cascade,
  tier text not null check (tier in ('free', 'pro', 'business')),
  source text not null check (source in ('stripe', 'apple', 'none')),
  status text not null check (status in (
    'active', 'trialing', 'past_due', 'canceled', 'expired', 'unknown'
  )),
  eligible boolean not null default false,
  observed_at timestamptz not null default now(),
  valid_until timestamptz,
  updated_at timestamptz not null default now()
);

-- Durable intent before any provider purchase. The request UUID is also
-- stamped into Twilio's friendly name so a crash after purchase can be
-- reconciled without buying a second number.
create table if not exists public.sms_provisioning_operations (
  request_id uuid primary key,
  manager_user_id uuid not null,
  area_code text,
  state text not null check (state in (
    'claimed', 'provider_found', 'attached', 'persisted', 'failed', 'released'
  )),
  phone_number_sid text,
  phone_number text,
  messaging_service_sid text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sms_provisioning_operations_manager_idx
  on public.sms_provisioning_operations (manager_user_id, created_at desc);

-- Append-only evidence. Global STOP/START remains in sms_consent; this table
-- answers the separate question "what did this recipient consent to?".
create table if not exists public.sms_consent_events (
  id uuid primary key default gen_random_uuid(),
  recipient_phone_key text not null check (recipient_phone_key ~ '^[0-9]{10,15}$'),
  -- Retain the tenant key as compliance evidence even if the login is deleted.
  manager_user_id uuid not null,
  messaging_service_sid text,
  campaign_sid text,
  purpose text not null,
  send_class text not null check (send_class in ('transactional', 'automated')),
  conversation_key text,
  event_type text not null check (event_type in ('granted', 'revoked')),
  source text not null,
  wording_version text,
  evidence jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists sms_consent_events_scope_idx
  on public.sms_consent_events (
    recipient_phone_key, manager_user_id, purpose, send_class, occurred_at desc
  );

create table if not exists public.sms_outbox (
  id uuid primary key default gen_random_uuid(),
  -- Outbound audit survives account deletion; actor identity may be nulled.
  manager_user_id uuid not null,
  actor_user_id uuid references auth.users (id) on delete set null,
  recipient_user_id uuid references auth.users (id) on delete set null,
  recipient_email text,
  recipient_phone text not null,
  body text not null check (char_length(body) between 1 and 1600),
  send_class text not null check (send_class in ('control', 'transactional', 'automated')),
  purpose text not null,
  conversation_key text,
  counterparty_role text check (counterparty_role in ('resident', 'applicant', 'prospect', 'manager', 'vendor', 'admin', 'unknown')),
  property_id text,
  recipient_timezone text not null default 'America/Los_Angeles',
  dedupe_key text not null,
  trace_id text,
  segment_count integer not null check (segment_count between 1 and 10),
  status text not null default 'queued' check (status in (
    'queued', 'claimed', 'deferred', 'submitting', 'submitted',
    'sent', 'delivered', 'failed', 'blocked', 'unknown', 'canceled'
  )),
  available_at timestamptz not null default now(),
  lease_owner text,
  lease_expires_at timestamptz,
  dispatch_started_at timestamptz,
  provider_message_sid text,
  provider_status text,
  provider_status_rank integer not null default 0,
  provider_error_code text,
  provider_status_at timestamptz,
  blocked_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (manager_user_id, dedupe_key)
);

create unique index if not exists sms_outbox_provider_sid_uniq
  on public.sms_outbox (provider_message_sid)
  where provider_message_sid is not null;

create index if not exists sms_outbox_claim_idx
  on public.sms_outbox (available_at, created_at)
  where status in ('queued', 'deferred', 'claimed');

create table if not exists public.sms_delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  outbox_id uuid not null references public.sms_outbox (id) on delete cascade,
  attempt_number integer not null check (attempt_number > 0),
  state text not null check (state in (
    'claimed', 'pre_dispatch_failed', 'submitting', 'submitted',
    'provider_rejected', 'unknown'
  )),
  provider_message_sid text,
  provider_error_code text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (outbox_id, attempt_number)
);

create table if not exists public.sms_provider_events (
  event_id text primary key,
  event_type text not null,
  provider_occurred_at timestamptz not null,
  account_sid text,
  messaging_service_sid text,
  campaign_sid text,
  phone_number_sid text,
  phone_number text,
  payload jsonb not null,
  applied boolean not null default false,
  rejection_reason text,
  received_at timestamptz not null default now()
);

create table if not exists public.sms_delivery_events (
  id uuid primary key default gen_random_uuid(),
  message_sid text not null,
  status text not null,
  status_rank integer not null,
  error_code text,
  provider_occurred_at timestamptz not null default now(),
  received_at timestamptz not null default now(),
  unique (message_sid, status, provider_occurred_at)
);

create unique index if not exists sms_delivery_events_callback_dedupe_idx
  on public.sms_delivery_events (message_sid, status, coalesce(error_code, ''));

create table if not exists public.sms_segment_usage (
  usage_date date primary key,
  segment_count integer not null default 0 check (segment_count >= 0),
  updated_at timestamptz not null default now()
);

-- Replay protection and durable audit for carrier control keywords. The
-- consent mutation and receipt insertion happen in one transaction below.
create table if not exists public.sms_control_receipts (
  message_sid text primary key,
  recipient_phone_key text not null check (recipient_phone_key ~ '^[0-9]{10,15}$'),
  manager_user_id uuid,
  messaging_service_sid text,
  keyword text not null check (keyword in ('STOP', 'START', 'HELP')),
  provider_occurred_at timestamptz not null,
  received_at timestamptz not null default now()
);

-- Distributed idempotency claim for normal inbound work-number messages. This
-- is separate from inbound_sms_log: the log is the user-visible transcript,
-- while this receipt owns side-effect execution across concurrent webhooks.
create table if not exists public.sms_inbound_receipts (
  message_sid text primary key,
  manager_user_id uuid not null,
  recipient_phone_key text not null check (recipient_phone_key ~ '^[0-9]{10,15}$'),
  status text not null check (status in ('processing', 'retryable', 'completed')),
  lease_owner text,
  lease_expires_at timestamptz,
  first_received_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create or replace function public.apply_sms_control_keyword(
  p_message_sid text,
  p_recipient_phone_key text,
  p_keyword text,
  p_provider_occurred_at timestamptz,
  p_manager_user_id uuid default null,
  p_messaging_service_sid text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_inserted text;
  v_received_at timestamptz := now();
  v_occurred_at timestamptz := p_provider_occurred_at;
begin
  if coalesce(trim(p_message_sid), '') = ''
     or p_recipient_phone_key !~ '^[0-9]{10,15}$'
     or p_provider_occurred_at is null
     or p_provider_occurred_at > now() + interval '5 minutes'
     or p_keyword not in ('STOP', 'START', 'HELP') then
    raise exception 'invalid sms control receipt';
  end if;

  insert into public.sms_control_receipts (
    message_sid, recipient_phone_key, manager_user_id,
    messaging_service_sid, keyword, provider_occurred_at, received_at
  ) values (
    p_message_sid, p_recipient_phone_key, p_manager_user_id,
    p_messaging_service_sid, p_keyword, v_occurred_at, v_received_at
  )
  on conflict (message_sid) do nothing
  returning message_sid into v_inserted;
  if v_inserted is null then return false; end if;

  -- STOP is deliberately fail-safe and always suppresses. START is applied
  -- only when its provider creation time is newer than every already-recorded
  -- STOP for this phone. That prevents a delayed retry of an older, signed
  -- START webhook from reopening consent after a newer STOP.
  if p_keyword = 'START' and exists (
    select 1
    from public.sms_control_receipts r
    where r.recipient_phone_key = p_recipient_phone_key
      and r.keyword = 'STOP'
      and (
        r.provider_occurred_at > v_occurred_at
        or r.provider_occurred_at = v_occurred_at
      )
  ) then
    return false;
  end if;

  if p_keyword = 'STOP' then
    insert into public.sms_consent (phone, opted_out_at, updated_at)
    values (p_recipient_phone_key, v_occurred_at, v_received_at)
    on conflict (phone) do update
      set opted_out_at = greatest(public.sms_consent.opted_out_at, excluded.opted_out_at),
          updated_at = greatest(public.sms_consent.updated_at, excluded.updated_at);

    if p_manager_user_id is not null and p_messaging_service_sid is not null then
      insert into public.sms_consent_events (
        recipient_phone_key, manager_user_id, messaging_service_sid,
        campaign_sid, purpose, send_class, conversation_key, event_type,
        source, wording_version, evidence, occurred_at
      )
      select p_recipient_phone_key, p_manager_user_id, p_messaging_service_sid,
             latest.campaign_sid, latest.purpose, latest.send_class,
             latest.conversation_key, 'revoked', 'twilio_stop',
             latest.wording_version, '{}'::jsonb, v_occurred_at
      from (
        select distinct on (purpose, send_class, coalesce(conversation_key, ''))
          campaign_sid, purpose, send_class, conversation_key,
          event_type, wording_version
        from public.sms_consent_events
        where recipient_phone_key = p_recipient_phone_key
          and manager_user_id = p_manager_user_id
          and messaging_service_sid = p_messaging_service_sid
        order by purpose, send_class, coalesce(conversation_key, ''),
                 occurred_at desc, created_at desc
      ) latest
      where latest.event_type = 'granted';
    end if;
  elsif p_keyword = 'START' then
    insert into public.sms_consent (phone, opted_in_at, consent_source, updated_at)
    values (p_recipient_phone_key, v_occurred_at, 'twilio_start', v_received_at)
    on conflict (phone) do update
      set opted_in_at = excluded.opted_in_at,
          consent_source = excluded.consent_source,
          updated_at = greatest(public.sms_consent.updated_at, excluded.updated_at)
      where public.sms_consent.opted_out_at is null
         or public.sms_consent.opted_out_at < excluded.opted_in_at;

    if p_manager_user_id is not null and p_messaging_service_sid is not null then
      insert into public.sms_consent_events (
        recipient_phone_key, manager_user_id, messaging_service_sid,
        campaign_sid, purpose, send_class, conversation_key, event_type,
        source, wording_version, evidence, occurred_at
      )
      select p_recipient_phone_key, p_manager_user_id, p_messaging_service_sid,
             latest.campaign_sid, latest.purpose, latest.send_class,
             latest.conversation_key, 'granted', 'twilio_start',
             latest.wording_version, '{}'::jsonb, v_occurred_at
      from (
        select distinct on (purpose, send_class, coalesce(conversation_key, ''))
          campaign_sid, purpose, send_class, conversation_key,
          event_type, wording_version, occurred_at
        from public.sms_consent_events
        where recipient_phone_key = p_recipient_phone_key
          and manager_user_id = p_manager_user_id
          and messaging_service_sid = p_messaging_service_sid
        order by purpose, send_class, coalesce(conversation_key, ''),
                 occurred_at desc, created_at desc
      ) latest
      where latest.event_type = 'revoked'
        and latest.occurred_at < v_occurred_at;
    end if;
  end if;
  return true;
end;
$$;

create or replace function public.claim_sms_inbound(
  p_message_sid text,
  p_manager_user_id uuid,
  p_recipient_phone_key text,
  p_worker_id text,
  p_lease_seconds integer default 120
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_claimed text;
begin
  if coalesce(trim(p_message_sid), '') = ''
     or p_manager_user_id is null
     or p_recipient_phone_key !~ '^[0-9]{10,15}$'
     or coalesce(trim(p_worker_id), '') = '' then
    raise exception 'invalid inbound sms claim';
  end if;

  insert into public.sms_inbound_receipts (
    message_sid, manager_user_id, recipient_phone_key, status,
    lease_owner, lease_expires_at
  ) values (
    p_message_sid, p_manager_user_id, p_recipient_phone_key, 'processing',
    p_worker_id, now() + make_interval(secs => greatest(30, least(p_lease_seconds, 300)))
  )
  on conflict (message_sid) do nothing
  returning message_sid into v_claimed;
  if v_claimed is not null then return true; end if;

  update public.sms_inbound_receipts
  set status = 'processing',
      lease_owner = p_worker_id,
      lease_expires_at = now() + make_interval(secs => greatest(30, least(p_lease_seconds, 300))),
      updated_at = now()
  where message_sid = p_message_sid
    and manager_user_id = p_manager_user_id
    and recipient_phone_key = p_recipient_phone_key
    and (
      status = 'retryable'
      or (status = 'processing' and lease_expires_at < now())
    )
  returning message_sid into v_claimed;
  return v_claimed is not null;
end;
$$;

create or replace function public.claim_sms_outbox(
  p_worker_id text,
  p_limit integer default 10,
  p_lease_seconds integer default 120,
  p_outbox_id uuid default null
)
returns setof public.sms_outbox
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(trim(p_worker_id), '') = '' then
    raise exception 'worker id is required';
  end if;

  return query
  with candidates as (
    select o.id
    from public.sms_outbox o
    where o.dispatch_started_at is null
      and (p_outbox_id is null or o.id = p_outbox_id)
      and o.available_at <= now()
      and (
        o.status in ('queued', 'deferred')
        or (
          o.status = 'claimed'
          and o.lease_expires_at < now()
        )
      )
    order by o.available_at, o.created_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 10), 100))
  )
  update public.sms_outbox o
  set status = 'claimed',
      lease_owner = p_worker_id,
      lease_expires_at = now() + make_interval(secs => greatest(15, least(p_lease_seconds, 300))),
      updated_at = now()
  from candidates c
  where o.id = c.id
  returning o.*;
end;
$$;

create or replace function public.claim_manager_sms_provisioning(
  p_manager_user_id uuid,
  p_request_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_claimed uuid;
begin
  update public.manager_sms_numbers
  set provision_state = 'provisioning',
      provision_request_id = p_request_id,
      attachment_state = 'attaching',
      attempts = attempts + 1,
      last_error = null,
      updated_at = now()
  where manager_user_id = p_manager_user_id
    and (
      provision_state in ('pending_registration', 'failed')
    )
  returning manager_user_id into v_claimed;
  return v_claimed is not null;
end;
$$;

create or replace function public.spend_sms_segment_budget(p_segments integer)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer;
  v_count integer;
begin
  if p_segments is null or p_segments < 1 or p_segments > 10 then
    return false;
  end if;
  select campaign_daily_segment_limit into v_limit
  from public.sms_runtime_config
  where singleton = true;
  if v_limit is null then return false; end if;
  if p_segments > v_limit then return false; end if;

  insert into public.sms_segment_usage (usage_date, segment_count)
  values ((now() at time zone 'utc')::date, p_segments)
  on conflict (usage_date) do update
    set segment_count = public.sms_segment_usage.segment_count + excluded.segment_count,
        updated_at = now()
    where public.sms_segment_usage.segment_count + excluded.segment_count <= v_limit
  returning segment_count into v_count;
  return v_count is not null and v_count <= v_limit;
end;
$$;

create or replace function public.apply_manager_sms_number_event(
  p_phone_number_sid text,
  p_messaging_service_sid text,
  p_campaign_sid text,
  p_registration_state text,
  p_provider_occurred_at timestamptz,
  p_error text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_manager_user_id uuid;
  v_provision_state text;
begin
  if p_registration_state not in ('pending', 'registered', 'failed', 'deregistering', 'deregistered') then
    return null;
  end if;
  v_provision_state := case
    when p_registration_state = 'registered' then 'active'
    when p_registration_state = 'pending' then 'provisioning'
    when p_registration_state = 'failed' then 'failed'
    when p_registration_state = 'deregistered' then 'released'
    else null
  end;
  update public.manager_sms_numbers
  set number_registration_state = p_registration_state,
      provision_state = coalesce(v_provision_state, provision_state),
      campaign_sid = coalesce(p_campaign_sid, campaign_sid),
      last_provider_event_at = p_provider_occurred_at,
      registration_updated_at = case when p_registration_state = 'registered' then p_provider_occurred_at else registration_updated_at end,
      deregistration_confirmed_at = case when p_registration_state = 'deregistered' then p_provider_occurred_at else deregistration_confirmed_at end,
      released_at = case when p_registration_state = 'deregistered' then p_provider_occurred_at else released_at end,
      quarantined_at = case
        when p_registration_state = 'registered' and quarantine_reason = 'carrier_registration_stale' then null
        else quarantined_at
      end,
      quarantine_reason = case
        when p_registration_state = 'registered' and quarantine_reason = 'carrier_registration_stale' then null
        else quarantine_reason
      end,
      last_error = case when p_registration_state = 'failed' then left(coalesce(p_error, 'Carrier registration did not complete.'), 500) when p_registration_state = 'registered' then null else last_error end,
      updated_at = now()
  where phone_number_sid = p_phone_number_sid
    and messaging_service_sid = p_messaging_service_sid
    and provision_state <> 'released'
    and (
      last_provider_event_at is null
      or last_provider_event_at < p_provider_occurred_at
      or (
        last_provider_event_at = p_provider_occurred_at
        and number_registration_state = p_registration_state
      )
    )
    and (p_registration_state <> 'registered' or attachment_state = 'attached')
  returning manager_user_id into v_manager_user_id;
  if v_manager_user_id is not null and p_registration_state = 'deregistered' then
    update public.profiles set sms_from_number = null, updated_at = now()
    where id = v_manager_user_id and sms_from_number = (
      select phone_number from public.manager_sms_numbers where manager_user_id = v_manager_user_id
    );
  end if;
  return v_manager_user_id;
end;
$$;

create or replace function public.apply_sms_delivery_status(
  p_message_sid text,
  p_status text,
  p_status_rank integer,
  p_error_code text,
  p_provider_occurred_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_outbox_id uuid;
begin
  update public.sms_outbox
  set provider_message_sid = coalesce(provider_message_sid, p_message_sid),
      status = case
        when p_status in ('delivered', 'read') then 'delivered'
        when p_status in ('failed', 'undelivered', 'canceled') then 'failed'
        when p_status = 'sent' then 'sent'
        else 'submitted'
      end,
      provider_status = p_status,
      provider_status_rank = p_status_rank,
      provider_error_code = p_error_code,
      provider_status_at = p_provider_occurred_at,
      updated_at = now()
  where (
      provider_message_sid = p_message_sid
      or (
        provider_message_sid is null
        and exists (
          select 1 from public.sms_delivery_attempts a
          where a.outbox_id = public.sms_outbox.id
            and a.provider_message_sid = p_message_sid
        )
      )
    )
    and coalesce(provider_status, '') not in ('delivered', 'read', 'failed', 'undelivered', 'canceled')
    and provider_status_rank <= p_status_rank
  returning id into v_outbox_id;
  return v_outbox_id;
end;
$$;

alter table public.sms_runtime_config enable row level security;
alter table public.sms_manager_entitlements enable row level security;
alter table public.sms_provisioning_operations enable row level security;
alter table public.sms_consent_events enable row level security;
alter table public.sms_outbox enable row level security;
alter table public.sms_delivery_attempts enable row level security;
alter table public.sms_provider_events enable row level security;
alter table public.sms_delivery_events enable row level security;
alter table public.sms_segment_usage enable row level security;
alter table public.sms_control_receipts enable row level security;
alter table public.sms_inbound_receipts enable row level security;

revoke all on table public.sms_runtime_config from anon, authenticated;
revoke all on table public.sms_manager_entitlements from anon, authenticated;
revoke all on table public.sms_provisioning_operations from anon, authenticated;
revoke all on table public.sms_consent_events from anon, authenticated;
revoke all on table public.sms_outbox from anon, authenticated;
revoke all on table public.sms_delivery_attempts from anon, authenticated;
revoke all on table public.sms_provider_events from anon, authenticated;
revoke all on table public.sms_delivery_events from anon, authenticated;
revoke all on table public.sms_segment_usage from anon, authenticated;
revoke all on table public.sms_control_receipts from anon, authenticated;
revoke all on table public.sms_inbound_receipts from anon, authenticated;
revoke execute on function public.apply_sms_control_keyword(text, text, text, timestamptz, uuid, text) from public, anon, authenticated;
grant execute on function public.apply_sms_control_keyword(text, text, text, timestamptz, uuid, text) to service_role;
revoke execute on function public.claim_sms_inbound(text, uuid, text, text, integer) from public, anon, authenticated;
grant execute on function public.claim_sms_inbound(text, uuid, text, text, integer) to service_role;
revoke execute on function public.claim_sms_outbox(text, integer, integer, uuid) from public, anon, authenticated;
grant execute on function public.claim_sms_outbox(text, integer, integer, uuid) to service_role;
revoke execute on function public.claim_manager_sms_provisioning(uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_manager_sms_provisioning(uuid, uuid) to service_role;
revoke execute on function public.spend_sms_segment_budget(integer) from public, anon, authenticated;
grant execute on function public.spend_sms_segment_budget(integer) to service_role;
revoke execute on function public.apply_manager_sms_number_event(text, text, text, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.apply_manager_sms_number_event(text, text, text, text, timestamptz, text) to service_role;
revoke execute on function public.apply_sms_delivery_status(text, text, integer, text, timestamptz) from public, anon, authenticated;
grant execute on function public.apply_sms_delivery_status(text, text, integer, text, timestamptz) to service_role;
