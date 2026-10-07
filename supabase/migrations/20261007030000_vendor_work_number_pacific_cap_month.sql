-- The vendor work number's fair-use cap resets on the PACIFIC calendar month,
-- not the UTC one. A text sent at 5pm PT on the last day of the month was being
-- counted against the NEXT month's cap (and the month the vendor's own usage
-- figure showed), because `date_trunc('month', now() at time zone 'utc')` rolls
-- over seven hours early. Same signature, same body, one boundary changed:
-- CREATE OR REPLACE, additive, safe to re-run.

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
  -- PACIFIC calendar month, not UTC: the cap resets when the vendor's month
  -- turns over, the same boundary `vendorNumberMonthStart` uses client-side.
  v_month_start := date_trunc('month', now() at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles';
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
