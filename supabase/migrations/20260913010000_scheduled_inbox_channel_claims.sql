-- A scheduled inbox row is the occurrence. Claim its channels before any side effect.
create table if not exists public.scheduled_inbox_channel_deliveries (
  message_id text not null references public.portal_scheduled_inbox_message_records(id) on delete cascade,
  manager_user_id uuid not null references auth.users(id) on delete cascade,
  channel text not null check (channel in ('inbox', 'email', 'sms')),
  status text not null check (status in ('claimed', 'submitted', 'failed', 'unknown', 'skipped')),
  claim_token uuid,
  claim_expires_at timestamptz,
  attempts integer not null default 0,
  last_error text,
  updated_at timestamptz not null default now(),
  primary key (message_id, channel)
);
create index if not exists scheduled_inbox_channel_deliveries_manager_idx
  on public.scheduled_inbox_channel_deliveries(manager_user_id);
alter table public.scheduled_inbox_channel_deliveries enable row level security;
revoke all on public.scheduled_inbox_channel_deliveries from anon, authenticated;
grant select, insert, update, delete on public.scheduled_inbox_channel_deliveries to service_role;

-- Existing edit/cancel/delete routes use the service-role client. Fence their
-- stale reads at the row itself once a sender claims it.
create or replace function public.guard_sending_inbox_message()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'sending' then raise exception 'Scheduled message delivery is in progress'; end if;
    return old;
  end if;
  if old.status = 'sending' and (
    new.status <> 'sent' or current_setting('app.scheduled_inbox_finalizing', true) is distinct from '1'
  ) then
    raise exception 'Scheduled message delivery is in progress';
  end if;
  return new;
end;
$$;
drop trigger if exists guard_sending_inbox_message on public.portal_scheduled_inbox_message_records;
create trigger guard_sending_inbox_message before update or delete
  on public.portal_scheduled_inbox_message_records for each row
  execute function public.guard_sending_inbox_message();

create or replace function public.claim_scheduled_inbox_channel(
  p_message_id text, p_manager_user_id uuid, p_channel text
)
returns table (outcome text, token uuid)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row public.portal_scheduled_inbox_message_records%rowtype;
  v_delivery public.scheduled_inbox_channel_deliveries%rowtype;
  v_token uuid := gen_random_uuid();
begin
  if p_channel not in ('inbox', 'email', 'sms') then raise exception 'invalid scheduled inbox channel'; end if;
  select * into v_row from public.portal_scheduled_inbox_message_records
    where id = p_message_id and manager_user_id = p_manager_user_id for update;
  if not found then return query select 'missing'::text, null::uuid; return; end if;
  if v_row.status not in ('scheduled', 'sending') then
    return query select v_row.status, null::uuid; return;
  end if;
  if v_row.status = 'scheduled' then
    update public.portal_scheduled_inbox_message_records
      set status = 'sending', updated_at = now() where id = p_message_id;
  end if;
  insert into public.scheduled_inbox_channel_deliveries(message_id, manager_user_id, channel, status, claim_token, claim_expires_at, attempts)
    values (p_message_id, p_manager_user_id, p_channel, 'claimed', v_token, now() + interval '10 minutes', 1)
    on conflict (message_id, channel) do nothing;
  select * into v_delivery from public.scheduled_inbox_channel_deliveries
    where message_id = p_message_id and channel = p_channel for update;
  if v_delivery.claim_token = v_token then
    return query select 'claimed'::text, v_token;
  elsif v_delivery.status = 'failed' then
    update public.scheduled_inbox_channel_deliveries
      set status = 'claimed', claim_token = v_token, claim_expires_at = now() + interval '10 minutes',
          attempts = attempts + 1, last_error = null, updated_at = now()
      where message_id = p_message_id and channel = p_channel;
    return query select 'claimed'::text, v_token;
  elsif v_delivery.status = 'claimed' and v_delivery.claim_expires_at < now() then
    update public.scheduled_inbox_channel_deliveries
      set status = 'unknown', claim_token = null, claim_expires_at = null,
          last_error = 'claim_expired_after_possible_submission', updated_at = now()
      where message_id = p_message_id and channel = p_channel;
    return query select 'unknown'::text, null::uuid;
  else
    return query select v_delivery.status, null::uuid;
  end if;
end;
$$;

create or replace function public.resolve_scheduled_inbox_channel(
  p_message_id text, p_channel text, p_token uuid, p_status text, p_error text default null
)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_updated integer;
begin
  if p_status not in ('submitted', 'failed', 'unknown', 'skipped') then
    raise exception 'invalid scheduled inbox resolution';
  end if;
  update public.scheduled_inbox_channel_deliveries
    set status = p_status, claim_token = null, claim_expires_at = null,
        last_error = p_error, updated_at = now()
    where message_id = p_message_id and channel = p_channel
      and status = 'claimed' and claim_token = p_token;
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

create or replace function public.finalize_scheduled_inbox_delivery(p_message_id text, p_manager_user_id uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_row public.portal_scheduled_inbox_message_records%rowtype;
begin
  select * into v_row from public.portal_scheduled_inbox_message_records
    where id = p_message_id and manager_user_id = p_manager_user_id for update;
  if not found then return false; end if;
  if v_row.status = 'sent' then return true; end if;
  if v_row.status <> 'sending' then return false; end if;
  if (select count(*) from public.scheduled_inbox_channel_deliveries where message_id = p_message_id) <> 3
    or exists (select 1 from public.scheduled_inbox_channel_deliveries
      where message_id = p_message_id and status not in ('submitted', 'skipped')) then
    return false;
  end if;
  perform set_config('app.scheduled_inbox_finalizing', '1', true);
  update public.portal_scheduled_inbox_message_records
    set status = 'sent', row_data = row_data || jsonb_build_object('sentAt', now()), updated_at = now()
    where id = p_message_id;
  perform set_config('app.scheduled_inbox_finalizing', '0', true);
  return true;
end;
$$;

revoke execute on function public.claim_scheduled_inbox_channel(text, uuid, text) from public, anon, authenticated;
revoke execute on function public.resolve_scheduled_inbox_channel(text, text, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.finalize_scheduled_inbox_delivery(text, uuid) from public, anon, authenticated;
grant execute on function public.claim_scheduled_inbox_channel(text, uuid, text) to service_role;
grant execute on function public.resolve_scheduled_inbox_channel(text, text, uuid, text, text) to service_role;
grant execute on function public.finalize_scheduled_inbox_delivery(text, uuid) to service_role;
