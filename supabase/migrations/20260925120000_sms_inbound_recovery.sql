-- Server-owned recovery for claimed inbound SMS.
--
-- Twilio's default webhook retry policy only retries connect/TLS failures, so a
-- 5xx after `claim_sms_inbound` was never retried and the receipt stayed stuck.
-- The webhook now stores the inbound payload on its receipt and a cron sweeper
-- reclaims `retryable` or lease-expired receipts and reruns the same pipeline.

alter table public.sms_inbound_receipts
  add column if not exists inbound_payload jsonb,
  add column if not exists attempt_count integer not null default 0;

-- Sweeper scan: only unfinished receipts that can be rebuilt.
create index if not exists sms_inbound_receipts_recovery_idx
  on public.sms_inbound_receipts (first_received_at)
  where status in ('processing', 'retryable') and inbound_payload is not null;

-- The payload carries the sender phone and body; keep it only while it can
-- still be needed. The transcript copy lives in inbound_sms_log.
create or replace function public.clear_completed_sms_inbound_payload()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.status = 'completed' then
    new.inbound_payload := null;
  end if;
  return new;
end;
$$;

drop trigger if exists sms_inbound_receipts_clear_payload on public.sms_inbound_receipts;
create trigger sms_inbound_receipts_clear_payload
  before insert or update of status, inbound_payload on public.sms_inbound_receipts
  for each row execute function public.clear_completed_sms_inbound_payload();

revoke execute on function public.clear_completed_sms_inbound_payload() from public, anon, authenticated;

-- Replaces the 20260825120000 claim. The payload is written in the same
-- statement as the claim, so no claimed receipt can exist without the data the
-- sweeper needs. A reclaim passes null and keeps the stored payload. Every
-- successful claim is counted so the sweeper can stop on a poison message.
-- Dropped first: an added defaulted argument would otherwise leave two
-- overloads that PostgREST cannot choose between.
drop function if exists public.claim_sms_inbound(text, uuid, text, text, integer);

create function public.claim_sms_inbound(
  p_message_sid text,
  p_manager_user_id uuid,
  p_recipient_phone_key text,
  p_worker_id text,
  p_lease_seconds integer default 120,
  p_inbound_payload jsonb default null
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
    lease_owner, lease_expires_at, attempt_count, inbound_payload
  ) values (
    p_message_sid, p_manager_user_id, p_recipient_phone_key, 'processing',
    p_worker_id, now() + make_interval(secs => greatest(30, least(p_lease_seconds, 300))), 1,
    p_inbound_payload
  )
  on conflict (message_sid) do nothing
  returning message_sid into v_claimed;
  if v_claimed is not null then return true; end if;

  update public.sms_inbound_receipts
  set status = 'processing',
      lease_owner = p_worker_id,
      lease_expires_at = now() + make_interval(secs => greatest(30, least(p_lease_seconds, 300))),
      attempt_count = attempt_count + 1,
      inbound_payload = coalesce(p_inbound_payload, inbound_payload),
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

revoke execute on function public.claim_sms_inbound(text, uuid, text, text, integer, jsonb) from public, anon, authenticated;
grant execute on function public.claim_sms_inbound(text, uuid, text, text, integer, jsonb) to service_role;
