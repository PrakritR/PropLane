-- Resident PropLane agent number: a subscribed resident's personal work number. A thin parallel
-- of vendor_work_identities (phone only, no email, no forwarding) that reuses the same provider
-- adapter, kill switch and release worker. Additive and idempotent: touches no existing table.
--
--   * One row per resident (unique resident_user_id), one number (unique phone_number), so a
--     second provisioning attempt can never buy a second number: the insert is the claim.
--   * `operation_id` is the durable friendly-name key at the provider, so an interrupted purchase
--     is found again (findSmsByOperation) instead of bought twice.
--   * Written ONLY by the service role. The owner may SELECT their own row's non-secret columns.
--   * Deleting the account queues the provider release on the existing vendor release queue (no
--     foreign keys by design) BEFORE the cascade removes this row.

create table if not exists public.resident_agent_numbers (
  id uuid primary key default gen_random_uuid(),
  resident_user_id uuid not null unique references auth.users(id) on delete cascade,
  state text not null default 'provisioning'
    check (state in ('provisioning', 'reconciling', 'ready', 'blocked', 'disabled', 'released')),
  operation_id uuid not null default gen_random_uuid(),
  phone_number text unique,
  phone_number_sid text,
  messaging_service_sid text,
  attachment_state text not null default 'provisioning'
    check (attachment_state in ('provisioning', 'attached', 'reconciling', 'failed', 'released')),
  carrier_ready boolean not null default false,
  sms_send_ready boolean not null default false,
  sms_receive_ready boolean not null default false,
  quarantine_reason text,
  last_error text,
  released_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint resident_agent_numbers_ready_requires_actual_readiness check (
    state <> 'ready' or (phone_number is not null and phone_number_sid is not null and attachment_state = 'attached' and sms_receive_ready)
  )
);
create index if not exists resident_agent_numbers_state_idx on public.resident_agent_numbers (state, updated_at);

alter table public.resident_agent_numbers enable row level security;
revoke all on public.resident_agent_numbers from anon, authenticated;
grant all on public.resident_agent_numbers to service_role;
-- Own row, non-secret columns only: no provider ids reach the client.
grant select (id, resident_user_id, state, phone_number, sms_receive_ready, sms_send_ready, created_at, updated_at)
  on public.resident_agent_numbers to authenticated;
drop policy if exists resident_agent_numbers_select_own on public.resident_agent_numbers;
create policy resident_agent_numbers_select_own on public.resident_agent_numbers
  for select to authenticated using (resident_user_id = (select auth.uid()));

-- Account deletion: hand the provider ids to the existing release worker, then disable sends.
create or replace function public.queue_resident_agent_number_release(p_user_id uuid)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_count integer := 0;
begin
  insert into public.vendor_work_identity_release_queue(
    vendor_user_id, identity_id, phone_number_sid, messaging_service_sid, idempotency_key
  )
  select r.resident_user_id, r.id, r.phone_number_sid, r.messaging_service_sid, 'release-resident:' || r.id::text
  from public.resident_agent_numbers r
  where r.resident_user_id = p_user_id and r.state <> 'released' and r.phone_number_sid is not null
  on conflict (idempotency_key) do nothing;
  get diagnostics v_count = row_count;
  update public.resident_agent_numbers
    set state = 'disabled', sms_send_ready = false, sms_receive_ready = false, updated_at = now()
    where resident_user_id = p_user_id and state not in ('released', 'disabled');
  return v_count;
end;
$$;
revoke execute on function public.queue_resident_agent_number_release(uuid) from public, anon, authenticated;
grant execute on function public.queue_resident_agent_number_release(uuid) to service_role;

-- The resident agent's SMS session is keyed like the manager/resident SMS ones: a verified phone
-- can change owners, so history is keyed by the user as well as the phone.
create unique index if not exists agent_sessions_resident_personal_sms_identity_uidx
  on public.agent_sessions (landlord_id, user_id, vendor_phone_e164)
  where kind = 'resident_personal_sms'
    and user_id is not null
    and vendor_phone_e164 is not null;
