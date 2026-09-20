-- One logical payment occurrence with separately claimed delivery channels.
create table if not exists public.payment_reminder_occurrences (
  id text primary key,
  manager_user_id uuid not null references auth.users(id) on delete cascade,
  recipient_email text not null,
  charge_ids text[] not null,
  subject text not null,
  body text not null,
  created_at timestamptz not null default now()
);
create table if not exists public.payment_reminder_channel_deliveries (
  occurrence_id text not null references public.payment_reminder_occurrences(id) on delete cascade,
  channel text not null check (channel in ('email', 'sms', 'inbox')),
  status text not null check (status in ('claimed', 'submitted', 'failed', 'unknown', 'skipped')),
  claim_token uuid,
  claim_expires_at timestamptz,
  attempts integer not null default 0,
  provider_reference text,
  last_error text,
  submitted_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (occurrence_id, channel)
);
-- Legacy per-charge aliases fence regrouped occurrences as well as exact retries.
create table if not exists public.payment_reminder_channel_coverage (
  manager_user_id uuid not null references auth.users(id) on delete cascade,
  dedup_id text not null,
  channel text not null check (channel in ('email', 'sms', 'inbox')),
  occurrence_id text not null references public.payment_reminder_occurrences(id) on delete cascade,
  primary key (manager_user_id, dedup_id, channel)
);
create index if not exists payment_reminder_occurrences_manager_idx
  on public.payment_reminder_occurrences(manager_user_id, created_at desc);
create index if not exists payment_reminder_occurrences_charge_ids_idx
  on public.payment_reminder_occurrences using gin(charge_ids);
alter table public.payment_reminder_occurrences enable row level security;
alter table public.payment_reminder_channel_deliveries enable row level security;
alter table public.payment_reminder_channel_coverage enable row level security;
revoke all on public.payment_reminder_occurrences from anon, authenticated;
revoke all on public.payment_reminder_channel_deliveries from anon, authenticated;
revoke all on public.payment_reminder_channel_coverage from anon, authenticated;
grant select, insert, update, delete on public.payment_reminder_occurrences to service_role;
grant select, insert, update, delete on public.payment_reminder_channel_deliveries to service_role;
grant select, insert, update, delete on public.payment_reminder_channel_coverage to service_role;

create or replace function public.claim_payment_reminder_channel(
  p_occurrence_id text, p_manager_user_id uuid, p_recipient_email text,
  p_charge_ids text[], p_dedup_ids text[], p_subject text, p_body text, p_channel text
)
returns table (outcome text, token uuid)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id text;
  v_occurrence public.payment_reminder_occurrences%rowtype;
  v_delivery public.payment_reminder_channel_deliveries%rowtype;
  v_token uuid := gen_random_uuid();
begin
  if p_manager_user_id is null or coalesce(trim(p_occurrence_id), '') = ''
    or coalesce(trim(p_recipient_email), '') = '' or p_channel not in ('email', 'sms', 'inbox')
    or cardinality(p_charge_ids) = 0 or cardinality(p_dedup_ids) = 0
    or array_position(p_charge_ids, null) is not null or array_position(p_dedup_ids, null) is not null then
    raise exception 'invalid payment reminder claim';
  end if;
  -- Serialize overlapping bundles by each per-charge alias before checking coverage.
  for v_id in select distinct unnest(p_dedup_ids) order by 1 loop
    perform pg_advisory_xact_lock(hashtextextended(p_manager_user_id::text || ':' || v_id || ':' || p_channel, 0));
  end loop;
  insert into public.payment_reminder_occurrences(id, manager_user_id, recipient_email, charge_ids, subject, body)
  values (p_occurrence_id, p_manager_user_id, lower(trim(p_recipient_email)), p_charge_ids, p_subject, p_body)
  on conflict (id) do nothing;
  select * into v_occurrence from public.payment_reminder_occurrences where id = p_occurrence_id for update;
  if v_occurrence.manager_user_id <> p_manager_user_id
    or v_occurrence.recipient_email <> lower(trim(p_recipient_email))
    or v_occurrence.charge_ids <> p_charge_ids
    or v_occurrence.subject <> p_subject or v_occurrence.body <> p_body then
    return query select 'revision_conflict'::text, null::uuid;
    return;
  end if;
  if exists (select 1 from public.payment_reminder_channel_coverage c
    where c.manager_user_id = p_manager_user_id and c.channel = p_channel
      and c.dedup_id = any(p_dedup_ids) and c.occurrence_id <> p_occurrence_id) then
    return query select 'overlap'::text, null::uuid;
    return;
  end if;
  insert into public.payment_reminder_channel_coverage(manager_user_id, dedup_id, channel, occurrence_id)
  select p_manager_user_id, d, p_channel, p_occurrence_id from unnest(p_dedup_ids) d
  on conflict (manager_user_id, dedup_id, channel) do nothing;
  insert into public.payment_reminder_channel_deliveries(occurrence_id, channel, status, claim_token, claim_expires_at, attempts)
  values (p_occurrence_id, p_channel, 'claimed', v_token, now() + interval '10 minutes', 1)
  on conflict (occurrence_id, channel) do nothing;
  select * into v_delivery from public.payment_reminder_channel_deliveries
  where occurrence_id = p_occurrence_id and channel = p_channel for update;
  if v_delivery.claim_token = v_token then
    return query select 'claimed'::text, v_token;
  elsif v_delivery.status = 'failed' then
    update public.payment_reminder_channel_deliveries
    set status = 'claimed', claim_token = v_token, claim_expires_at = now() + interval '10 minutes',
        attempts = attempts + 1, last_error = null, updated_at = now()
    where occurrence_id = p_occurrence_id and channel = p_channel;
    return query select 'claimed'::text, v_token;
  elsif v_delivery.status = 'claimed' and v_delivery.claim_expires_at < now() then
    -- A lost worker may have submitted; expiration is unknown, never a blind retry.
    update public.payment_reminder_channel_deliveries
    set status = 'unknown', claim_token = null, claim_expires_at = null,
        last_error = 'claim_expired_after_possible_submission', updated_at = now()
    where occurrence_id = p_occurrence_id and channel = p_channel;
    return query select 'unknown'::text, null::uuid;
  else
    return query select v_delivery.status, null::uuid;
  end if;
end;
$$;

create or replace function public.resolve_payment_reminder_channel(
  p_occurrence_id text, p_channel text, p_token uuid, p_status text,
  p_provider_reference text default null, p_error text default null
)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_updated integer;
begin
  if p_status not in ('submitted', 'failed', 'unknown', 'skipped') then
    raise exception 'invalid payment reminder resolution';
  end if;
  update public.payment_reminder_channel_deliveries
  set status = p_status, claim_token = null, claim_expires_at = null,
      provider_reference = p_provider_reference, last_error = p_error,
      submitted_at = case when p_status = 'submitted' then now() else submitted_at end,
      updated_at = now()
  where occurrence_id = p_occurrence_id and channel = p_channel
    and status = 'claimed' and claim_token = p_token;
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;
revoke execute on function public.claim_payment_reminder_channel(text, uuid, text, text[], text[], text, text, text) from public, anon, authenticated;
revoke execute on function public.resolve_payment_reminder_channel(text, text, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.claim_payment_reminder_channel(text, uuid, text, text[], text[], text, text, text) to service_role;
grant execute on function public.resolve_payment_reminder_channel(text, text, uuid, text, text, text) to service_role;
