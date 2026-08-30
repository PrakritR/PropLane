-- Reminder spine: one queue for every remindable subject.
--
-- Before this, each entity grew its own reminder path and they all drained
-- from once-a-day crons, so a "30 minutes before" lead time could never fire —
-- the row sat until the next daily tick, after the event. This table is drained
-- by /api/cron/dispatch-reminders every 5 minutes instead.
--
-- Service-role only. Nothing here is client-reachable: the queue is written by
-- server code when a subject changes and read only by the dispatcher. Per
-- AGENTS.md, client roles get no DML on a table they never need to touch.

create table if not exists public.portal_reminder_records (
  id uuid primary key default gen_random_uuid(),
  manager_user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null,
  subject_id text not null,
  lead_minutes integer not null,
  recipient_email text not null,
  -- Which side of the conversation this copy is for. The manager and the guest
  -- each get their own row for the same reminder.
  recipient_role text not null,
  send_at timestamptz not null,
  status text not null default 'scheduled',
  -- Stable identity: (kind, subject, lead, recipient). A unique index on this
  -- is what makes re-materializing a subject idempotent — editing a tour twice
  -- can never queue the reminder twice.
  dedupe_key text not null,
  payload jsonb not null default '{}'::jsonb,
  attempts integer not null default 0,
  lease_owner text,
  lease_expires_at timestamptz,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'portal_reminder_records_kind_check') then
    alter table public.portal_reminder_records
      add constraint portal_reminder_records_kind_check
      check (kind in ('tour', 'task', 'service_order', 'work_order', 'booking'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'portal_reminder_records_status_check') then
    alter table public.portal_reminder_records
      add constraint portal_reminder_records_status_check
      check (status in ('scheduled', 'sending', 'sent', 'failed', 'cancelled'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'portal_reminder_records_role_check') then
    alter table public.portal_reminder_records
      add constraint portal_reminder_records_role_check
      check (recipient_role in ('manager', 'counterparty'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'portal_reminder_records_lead_check') then
    alter table public.portal_reminder_records
      add constraint portal_reminder_records_lead_check
      check (lead_minutes between 5 and 43200);
  end if;
end $$;

create unique index if not exists portal_reminder_records_dedupe_uidx
  on public.portal_reminder_records (dedupe_key);

-- The dispatcher's only hot query.
create index if not exists portal_reminder_records_due_idx
  on public.portal_reminder_records (status, send_at)
  where status in ('scheduled', 'sending');

-- Cancelling every pending reminder for a subject that moved or was deleted.
create index if not exists portal_reminder_records_subject_idx
  on public.portal_reminder_records (kind, subject_id);

alter table public.portal_reminder_records enable row level security;

/*
 * Atomically claim due reminders for one dispatcher run.
 *
 * `skip locked` means two overlapping cron invocations take disjoint work
 * instead of racing for the same row. The lease lets a run that dies mid-send
 * be reclaimed later without a human, while `attempts` keeps a permanently
 * failing row from being retried forever.
 */
create or replace function public.claim_due_reminders(
  p_worker_id text,
  p_limit integer,
  p_max_attempts integer default 5
)
returns setof public.portal_reminder_records
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(trim(p_worker_id), '') = '' or p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'invalid reminder claim';
  end if;

  return query
  with due as (
    select id
    from public.portal_reminder_records
    where send_at <= now()
      and attempts < p_max_attempts
      and (
        status = 'scheduled'
        -- Reclaim a lease abandoned by a run that died mid-send.
        or (status = 'sending' and lease_expires_at is not null and lease_expires_at < now())
      )
    order by send_at asc
    limit p_limit
    for update skip locked
  )
  update public.portal_reminder_records r
  set status = 'sending',
      lease_owner = p_worker_id,
      lease_expires_at = now() + interval '5 minutes',
      attempts = r.attempts + 1,
      updated_at = now()
  from due
  where r.id = due.id
  returning r.*;
end;
$$;

/** Close out a claimed reminder. Only the lease holder may resolve its own row. */
create or replace function public.resolve_reminder(
  p_id uuid,
  p_worker_id text,
  p_status text,
  p_error text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_id uuid;
begin
  if p_status not in ('sent', 'failed', 'scheduled') then
    raise exception 'invalid reminder resolution';
  end if;

  update public.portal_reminder_records
  set status = p_status,
      sent_at = case when p_status = 'sent' then now() else sent_at end,
      last_error = p_error,
      lease_owner = null,
      lease_expires_at = null,
      updated_at = now()
  where id = p_id
    and lease_owner = p_worker_id
    and status = 'sending'
  returning id into v_id;
  return v_id is not null;
end;
$$;

revoke all on table public.portal_reminder_records from anon, authenticated;
revoke execute on function public.claim_due_reminders(text, integer, integer) from public, anon, authenticated;
revoke execute on function public.resolve_reminder(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.claim_due_reminders(text, integer, integer) to service_role;
grant execute on function public.resolve_reminder(uuid, text, text, text) to service_role;
