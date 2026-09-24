-- Bound prospect burst retries. A worker failure used to requeue the burst
-- immediately and forever; on 2026-09-24 three bursts whose cached turn replayed
-- an empty result failed every cron sweep and exhausted the daily QStash quota.
-- Failures are now counted per revision (a new inbound text is a new revision
-- and starts over), backed off 1, 2, 4, 8 minutes, and after the fifth failure
-- the revision is left terminal ('failed', due_at infinity so no claim can take
-- it), which the recovery sweep skips. A backoff clears published_at so the next
-- sweep republishes with a delay of due_at - now: the sweep only republishes
-- queued rows whose publication is missing or over 10 minutes old.
alter table public.prospect_sms_bursts
  add column if not exists failed_revision integer not null default 0,
  add column if not exists failed_attempts integer not null default 0;

create or replace function public.complete_prospect_sms_burst(p_burst_id uuid, p_revision integer, p_worker_id text, p_status text, p_outbox_id uuid default null, p_candidate_body text default null)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if p_status not in ('suppressed','dispatched','failed') then raise exception 'invalid prospect burst completion'; end if;
  -- A superseded worker cannot publish. Release only its own old lease so the
  -- current revision can run as soon as the quiet window is due.
  update public.prospect_sms_bursts set status='queued', lease_owner=null, lease_expires_at=null, updated_at=now()
  where id=p_burst_id and revision <> p_revision and status='generating' and lease_owner=p_worker_id;
  if found then return false; end if;
  with attempt as (
    select case when p_status <> 'failed' then 0
                when failed_revision = p_revision then failed_attempts + 1
                else 1 end as n
    from public.prospect_sms_bursts where id = p_burst_id
    for update
  )
  update public.prospect_sms_bursts b set
    status = case when p_status <> 'failed' then p_status when attempt.n >= 5 then 'failed' else 'queued' end,
    handled_revision = case when p_status = 'failed' then b.handled_revision else p_revision end,
    failed_attempts = attempt.n,
    failed_revision = case when p_status = 'failed' then p_revision else b.failed_revision end,
    outbox_id = coalesce(p_outbox_id, b.outbox_id), candidate_body = p_candidate_body,
    due_at = case when p_status <> 'failed' then b.due_at
                  when attempt.n >= 5 then 'infinity'::timestamptz
                  else now() + make_interval(mins => least(8, power(2, attempt.n - 1)::integer)) end,
    published_at = case when p_status = 'failed' then null else b.published_at end,
    queue_job_id = case when p_status = 'failed' then null else b.queue_job_id end,
    lease_owner = null, lease_expires_at = null, updated_at = now()
  from attempt
  where b.id = p_burst_id and b.revision = p_revision and b.status = 'generating'
    and b.lease_owner = p_worker_id and b.lease_expires_at > now()
  returning b.id into v_id;
  return v_id is not null;
end; $$;

revoke execute on function public.complete_prospect_sms_burst(uuid,integer,text,text,uuid,text) from public, anon, authenticated;
grant execute on function public.complete_prospect_sms_burst(uuid,integer,text,text,uuid,text) to service_role;
