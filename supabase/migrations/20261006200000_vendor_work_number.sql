-- Vendor work number (Oct 6): any vendor with a verified phone can claim a
-- PropLane number; paid by the service fee, not a subscription.
-- Additive and idempotent. Written for the dev/test project first; never applied
-- by the build agent. Every table stays service-role only.

-- 1. Forwarding preference. Defaults ON: managers' texts reach the vendor's
--    verified personal phone, labelled "[<Workspace>] ...", unless turned off.
alter table public.vendor_work_identities
  add column if not exists forward_to_phone boolean not null default true;

-- 2. The fair-use cap is now MONTHLY segments (1,000), not lifetime. The runtime
--    row's `outbound_message_cap` stays the one knob; a never-configured 0 gets the
--    approved default. A value an operator already set is left alone.
update public.vendor_work_identity_runtime
  set outbound_message_cap = 1000, updated_at = now()
  where singleton = true and outbound_message_cap = 0;

create index if not exists vendor_work_identity_usage_events_identity_month_idx
  on public.vendor_work_identity_usage_events (identity_id, created_at);

-- 3. Cap reservation + outbox authorization stay one transaction. The cap is
--    now per UTC calendar month and counts SMS SEGMENTS (GSM-7 160/153, UCS-2
--    70/67 - the same estimate `estimateSmsSegments` uses), so a long text costs
--    what the carrier bills. Email keeps one unit per message, capped separately
--    by the same number. Same signature as before: CREATE OR REPLACE.
create or replace function public.claim_vendor_work_identity_outbound(
  p_vendor_user_id uuid,
  p_identity_id uuid,
  p_operation_id uuid,
  p_idempotency_key text,
  p_channel text,
  p_recipient text,
  p_context_fingerprint text,
  p_subject text,
  p_body text
) returns table(outbox_id uuid, claimed boolean, blocked_reason text)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_cap integer; v_used integer; v_ready boolean; v_existing uuid; v_operation_ok boolean;
  v_units integer; v_month_start timestamptz; v_meter text; v_ucs2 boolean; v_len integer;
begin
  if p_channel not in ('email','sms') then
    return query select null::uuid, false, 'invalid_channel'::text; return;
  end if;
  select outbound_message_cap into v_cap from public.vendor_work_identity_runtime where singleton = true and enabled = true for update;
  if not found then
    return query select null::uuid, false, 'provider_disabled'::text; return;
  end if;
  select case when p_channel = 'email' then email_state = 'ready' and email_send_ready else sms_state = 'ready' and sms_send_ready end
    into v_ready
  from public.vendor_work_identities where id = p_identity_id and vendor_user_id = p_vendor_user_id for update;
  select exists(select 1 from public.vendor_work_identity_operations o where o.id = p_operation_id and o.identity_id = p_identity_id and o.vendor_user_id = p_vendor_user_id and o.operation_kind = case when p_channel = 'email' then 'send_email' else 'send_sms' end)
    into v_operation_ok;
  select id into v_existing from public.vendor_work_identity_outbox
    where vendor_user_id = p_vendor_user_id and idempotency_key = p_idempotency_key and channel = p_channel;
  if v_existing is not null then
    return query select v_existing, false, null::text; return;
  end if;
  if coalesce(v_ready, false) = false then
    return query select null::uuid, false, 'identity_not_ready'::text; return;
  end if;
  if not v_operation_ok then
    return query select null::uuid, false, 'invalid_operation'::text; return;
  end if;
  v_meter := case when p_channel = 'email' then 'outbound_email' else 'outbound_sms' end;
  v_month_start := date_trunc('month', now() at time zone 'utc') at time zone 'utc';
  if p_channel = 'sms' then
    v_len := char_length(coalesce(p_body, ''));
    v_ucs2 := coalesce(p_body, '') !~ '^[\x01-\x7F]*$';
    v_units := case
      when v_len = 0 then 1
      when v_len <= (case when v_ucs2 then 70 else 160 end) then 1
      else ceil(v_len::numeric / (case when v_ucs2 then 67 else 153 end))::integer
    end;
  else
    v_units := 1;
  end if;
  select coalesce(sum(quantity), 0)::integer into v_used from public.vendor_work_identity_usage_events
    where identity_id = p_identity_id and meter = v_meter and created_at >= v_month_start;
  if v_cap <= 0 or v_used + v_units > v_cap then
    return query select null::uuid, false, 'platform_cap_reached'::text; return;
  end if;
  insert into public.vendor_work_identity_usage_events(identity_id,vendor_user_id,meter,quantity,idempotency_key)
    values (p_identity_id,p_vendor_user_id,v_meter,v_units,
      'outbound:' || p_vendor_user_id::text || ':' || p_identity_id::text || ':' || p_idempotency_key || ':' || p_channel);
  insert into public.vendor_work_identity_outbox(identity_id,vendor_user_id,operation_id,idempotency_key,channel,recipient,context_fingerprint,subject,body)
    values (p_identity_id,p_vendor_user_id,p_operation_id,p_idempotency_key,p_channel,p_recipient,p_context_fingerprint,p_subject,p_body)
    returning id into v_existing;
  return query select v_existing, true, null::text;
end;
$$;
revoke execute on function public.claim_vendor_work_identity_outbound(uuid,uuid,uuid,text,text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.claim_vendor_work_identity_outbound(uuid,uuid,uuid,text,text,text,text,text,text) to service_role;

-- 4. Who a vendor's number has talked to. One row per manager line the number
--    has exchanged texts with; the reply router reads it ("most recent
--    conversation", numbered prompt when 2+ are active in 24h or none recent).
--    Deleting the vendor's account cascades it.
create table if not exists public.vendor_work_number_conversations (
  id uuid primary key default gen_random_uuid(),
  identity_id uuid not null references public.vendor_work_identities(id) on delete cascade,
  vendor_user_id uuid not null references auth.users(id) on delete cascade,
  counterpart_phone text not null,
  manager_user_id uuid,
  workspace_id uuid,
  workspace_name text not null default '',
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  last_activity_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (identity_id, counterpart_phone)
);
create index if not exists vendor_work_number_conversations_recent_idx
  on public.vendor_work_number_conversations (identity_id, last_activity_at desc);
alter table public.vendor_work_number_conversations enable row level security;
revoke all on public.vendor_work_number_conversations from public, anon, authenticated;
grant select, insert, update on public.vendor_work_number_conversations to service_role;
