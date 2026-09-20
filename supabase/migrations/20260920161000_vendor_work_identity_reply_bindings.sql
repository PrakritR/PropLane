-- A portal inbox row is display data and may be edited by its owner.  Sending
-- identities therefore authorize replies from this service-role-only binding,
-- never from row_data.email / recipientPhone.
create table if not exists public.vendor_work_identity_reply_bindings (
  id uuid primary key default gen_random_uuid(),
  identity_id uuid not null references public.vendor_work_identities(id) on delete cascade,
  vendor_user_id uuid not null references auth.users(id) on delete cascade,
  thread_id text not null,
  channel text not null check (channel in ('email', 'sms')),
  recipient text not null,
  recipient_user_id uuid references auth.users(id) on delete set null,
  source_message_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (vendor_user_id, thread_id, channel)
);
create index if not exists vendor_work_identity_reply_bindings_lookup_idx
  on public.vendor_work_identity_reply_bindings(vendor_user_id, thread_id, channel);

alter table public.vendor_work_identity_reply_bindings enable row level security;
revoke all on public.vendor_work_identity_reply_bindings from public, anon, authenticated;
grant select, insert on public.vendor_work_identity_reply_bindings to service_role;

-- Deleting an auth account cascades its identity record, so the release queue
-- is also the capacity reservation. Capacity returns only after the release
-- worker records a provider-confirmed `released` state.
create or replace function public.ensure_vendor_work_identity(
  p_vendor_user_id uuid,
  p_email_address text default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  perform 1 from public.vendor_work_identity_runtime where singleton = true and enabled = true for update;
  if not found then return null; end if;
  select id into v_id from public.vendor_work_identities where vendor_user_id = p_vendor_user_id for update;
  if v_id is not null then
    if p_email_address is not null then
      update public.vendor_work_identities set email_address = coalesce(email_address, p_email_address), updated_at = now() where id = v_id;
    end if;
    return v_id;
  end if;
  -- A disabled but unreleased identity can have its own release queue row.
  -- Count that provider resource once, then separately reserve only orphaned
  -- (or already-released identity) queue rows left by account cleanup.
  if (
    (select count(*) from public.vendor_work_identities i where i.released_at is null) +
    (select count(*)
      from public.vendor_work_identity_release_queue q
      left join public.vendor_work_identities i on i.id = q.identity_id
      where q.state <> 'released' and (i.id is null or i.released_at is not null))
  ) >= (select max_active_identities from public.vendor_work_identity_runtime where singleton = true) then
    return null;
  end if;
  insert into public.vendor_work_identities(vendor_user_id, email_address)
    values (p_vendor_user_id, p_email_address)
    returning id into v_id;
  return v_id;
end;
$$;

-- One cron worker owns each provider release attempt. A timeout transitions to
-- reconciling and is deliberately not claimed again without an authoritative
-- provider inspection.
create or replace function public.claim_vendor_work_identity_releases(p_limit integer default 20)
returns table(id uuid, identity_id uuid, phone_number_sid text)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return query
  with candidates as (
    select q.id from public.vendor_work_identity_release_queue q
    where q.state = 'queued'
    order by q.created_at asc
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 20), 50))
  ), claimed as (
    update public.vendor_work_identity_release_queue q
      set state = 'calling_provider', attempts = q.attempts + 1, updated_at = now()
    from candidates c where q.id = c.id
    returning q.id, q.identity_id, q.phone_number_sid
  )
  select claimed.id, claimed.identity_id, claimed.phone_number_sid from claimed;
end;
$$;
revoke execute on function public.claim_vendor_work_identity_releases(integer) from public, anon, authenticated;
grant execute on function public.claim_vendor_work_identity_releases(integer) to service_role;

create or replace function public.queue_vendor_work_identity_release(p_vendor_user_id uuid)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_count integer := 0;
begin
  insert into public.vendor_work_identity_release_queue(
    vendor_user_id,identity_id,phone_number_sid,messaging_service_sid,email_address,idempotency_key
  )
  select i.vendor_user_id,i.id,i.phone_number_sid,i.messaging_service_sid,i.email_address,
    'release:' || i.id::text
  from public.vendor_work_identities i
  where i.vendor_user_id = p_vendor_user_id and i.lifecycle_state <> 'released'
  on conflict (idempotency_key) do nothing;
  get diagnostics v_count = row_count;
  update public.vendor_work_identities
    set lifecycle_state = 'disabled', email_state = 'disabled', sms_state = 'disabled', disabled_at = coalesce(disabled_at, now()), sms_send_ready = false, email_send_ready = false,
        updated_at = now()
    where vendor_user_id = p_vendor_user_id and lifecycle_state not in ('released','disabled');
  return v_count;
end;
$$;

-- Different browser request IDs for the same setup channel join the one
-- durable in-flight operation. The advisory lock closes the empty-row race
-- before any provider purchase can begin.
create or replace function public.claim_vendor_work_identity_operation(
  p_vendor_user_id uuid,
  p_identity_id uuid,
  p_operation_kind text,
  p_idempotency_key text
) returns table(operation_id uuid, claimed boolean, state text)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_existing public.vendor_work_identity_operations%rowtype;
begin
  if p_operation_kind in ('setup_email', 'setup_sms') then
    perform pg_advisory_xact_lock(hashtextextended(p_vendor_user_id::text || ':' || p_operation_kind, 0));
    select * into v_existing from public.vendor_work_identity_operations
      where vendor_user_id = p_vendor_user_id and identity_id = p_identity_id and operation_kind = p_operation_kind
        and vendor_work_identity_operations.state in ('claimed','calling_provider','reconciling')
      order by created_at desc limit 1;
    if found then return query select v_existing.id, false, v_existing.state; return; end if;
  end if;
  return query
  with inserted as (
    insert into public.vendor_work_identity_operations(identity_id, vendor_user_id, operation_kind, idempotency_key)
    select p_identity_id, p_vendor_user_id, p_operation_kind, p_idempotency_key
    where exists (select 1 from public.vendor_work_identities where id = p_identity_id and vendor_user_id = p_vendor_user_id)
    on conflict (vendor_user_id, operation_kind, idempotency_key) do nothing
    returning vendor_work_identity_operations.id, vendor_work_identity_operations.state
  )
  select inserted.id, true, inserted.state from inserted
  union all
  select o.id, false, o.state from public.vendor_work_identity_operations o
    where o.vendor_user_id = p_vendor_user_id and o.operation_kind = p_operation_kind and o.idempotency_key = p_idempotency_key
      and not exists (select 1 from inserted)
  limit 1;
end;
$$;
