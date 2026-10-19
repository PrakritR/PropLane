-- A durable prospect burst on the shared PropLane line could never be answered: resolve_sms_completed_receipt_original
-- proved the receiving line only through manager_sms_numbers, and the shared number has no such row, so every burst
-- ended "work_line_unproven" ("Original burst envelopes unavailable") and the prospect got no reply. Found by the
-- end-to-end harness (scripts/one-number/e2e-scenarios.mjs).
--
-- Additive and idempotent: the same function with ONE added branch, taken only when the work-number proof found
-- nothing. A per-workspace number is proven exactly as before; the shared line needs (a) line_mode = 'shared' and the
-- configured shared number as the receiving number and (b) a router-stamped workspace owned by the projected owner.
create or replace function public.resolve_sms_completed_receipt_original(p_sid text, p_expected_owner uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_receipt public.sms_inbound_receipts%rowtype;
  v_log public.inbound_sms_log%rowtype;
  v_ingress public.prospect_sms_ingress%rowtype;
  v_burst public.prospect_sms_bursts%rowtype;
  v_log_count integer;
  v_ingress_count integer;
  v_line_count integer;
  v_line_id uuid;
  v_body text;
  v_from text;
  v_to text;
  v_owner uuid;
  v_role text := 'unknown';
  v_user uuid;
  v_key text;
  v_sender_key text;
  v_trim_chars text := U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
begin
  if p_sid is null or p_sid = '' or p_expected_owner is null then
    return jsonb_build_object('ok',false,'reason','invalid_request');
  end if;
  select * into v_receipt from public.sms_inbound_receipts where message_sid = p_sid;
  if not found then return jsonb_build_object('ok',false,'reason','receipt_missing'); end if;
  v_owner := v_receipt.manager_user_id;
  if v_receipt.first_received_at is null or v_owner is null then
    return jsonb_build_object('ok',false,'reason','receipt_invalid');
  end if;
  select count(*) into v_log_count from public.inbound_sms_log l where l.message_sid=p_sid;
  if v_log_count > 1 then return jsonb_build_object('ok',false,'reason','log_ambiguous'); end if;
  if v_log_count=1 then
    select * into v_log from public.inbound_sms_log l where l.message_sid=p_sid;
  end if;
  select count(*) into v_ingress_count from public.prospect_sms_ingress i where i.source_message_id=p_sid;
  if v_ingress_count > 1 then return jsonb_build_object('ok',false,'reason','ingress_ambiguous'); end if;
  if v_ingress_count=1 then
    select * into v_ingress from public.prospect_sms_ingress i where i.source_message_id=p_sid;
  end if;
  if v_receipt.inbound_payload is not null then
    if jsonb_typeof(v_receipt.inbound_payload->'body') is distinct from 'string'
       or jsonb_typeof(v_receipt.inbound_payload->'fromPhone') is distinct from 'string'
       or jsonb_typeof(v_receipt.inbound_payload->'toPhone') is distinct from 'string' then
      return jsonb_build_object('ok',false,'reason','payload_invalid');
    end if;
    v_body := v_receipt.inbound_payload->>'body';
    v_from := v_receipt.inbound_payload->>'fromPhone';
    v_to := v_receipt.inbound_payload->>'toPhone';
  elsif v_receipt.status in ('completed','processing','retryable') and v_log_count = 1 then
    v_body := v_log.body; v_from := v_log.from_phone; v_to := v_log.to_phone;
  else
    return jsonb_build_object('ok',false,'reason','original_missing');
  end if;
  v_sender_key := regexp_replace(coalesce(v_from,''),'[^0-9]','','g');
  if length(v_sender_key)=11 and left(v_sender_key,1)='1' then
    v_sender_key := substr(v_sender_key,2);
  end if;
  if v_from is null or v_to is null or v_from !~ '^\+[0-9]{10,15}$' or v_to !~ '^\+[0-9]{10,15}$'
     or v_sender_key is distinct from v_receipt.recipient_phone_key then
    return jsonb_build_object('ok',false,'reason','wire_invalid');
  end if;
  if v_log_count = 1 then
    if v_log.manager_user_id is distinct from v_owner or v_log.body is distinct from v_body
       or v_log.from_phone is distinct from v_from or v_log.to_phone is distinct from v_to
       or v_log.counterparty_role is null
       or v_log.counterparty_role not in ('prospect','resident','applicant','vendor','manager','admin','unknown') then
      return jsonb_build_object('ok',false,'reason','log_conflict');
    end if;
    v_role := v_log.counterparty_role;
    v_user := v_log.matched_sender_user_id;
    v_key := v_log.conversation_key;
  end if;
  if v_ingress_count = 1 then
    select * into v_burst from public.prospect_sms_bursts where id=v_ingress.burst_id;
    if not found or v_ingress.channel <> 'twilio' or v_burst.channel <> 'sms'
       or v_burst.counterparty_role <> 'prospect'
       or v_ingress.manager_user_id is distinct from v_burst.manager_user_id
       or v_burst.counterparty_phone_e164 is distinct from v_from
       or v_burst.reply_from_number is distinct from v_to
       or (v_log_count=1 and (v_role <> 'prospect' or v_user is not null))
       -- Webhook String.trim() precedes record_prospect_sms_ingress left(...,2000).
       -- btrim's explicit Unicode set is ECMAScript WhiteSpace + LineTerminator.
       -- PostgreSQL left counts Unicode code points, including astral characters.
       or v_ingress.body is distinct from left(btrim(v_body,v_trim_chars),2000) then
      return jsonb_build_object('ok',false,'reason','ingress_conflict');
    end if;
    v_owner := v_ingress.manager_user_id;
    v_role := 'prospect'; v_user := null;
    -- One exact receiving epoch must bind the receipt holder to the
    -- projected workspace owner. A workspace match alone cannot authorize
    -- an unrelated receipt holder. Legacy unplaced rows belong to the holder.
    select count(*), (array_agg(n.id))[1] into v_line_count,v_line_id
      from public.manager_sms_numbers n
      left join public.portal_workspaces w on w.id=n.workspace_id
      where n.phone_number=v_to and n.provision_state in ('active','released')
        and n.manager_user_id=v_receipt.manager_user_id
        and (case when n.workspace_id is null then n.manager_user_id else w.owner_user_id end)=v_owner
        and coalesce(n.provisioned_at,n.requested_at) <= v_receipt.first_received_at
        and (n.released_at is null or v_receipt.first_received_at <= n.released_at);
    if v_line_count <> 1 then
      -- The shared PropLane line has no manager_sms_numbers row. It is proven the same way the application proves
      -- it for the projection: the receipt was sent to the configured shared number while the line is live, and
      -- the claim payload's workspace (stamped by the router, never by the sender) belongs to the projected owner,
      -- who is also the receipt holder. The line id of a shared line IS that workspace id.
      select count(*), (array_agg(w.id))[1] into v_line_count, v_line_id
        from public.sms_runtime_config c
        join public.portal_workspaces w
          on w.id = case when v_receipt.inbound_payload->>'workspaceId' ~ '^[0-9a-fA-F-]{36}$'
                         then (v_receipt.inbound_payload->>'workspaceId')::uuid end
        where c.singleton and c.line_mode = 'shared' and c.shared_number_e164 = v_to
          and w.owner_user_id = v_owner and v_receipt.manager_user_id = v_owner;
    end if;
    if v_line_count <> 1 then
      return jsonb_build_object('ok',false,'reason','work_line_unproven');
    end if;
  end if;
  if v_owner is distinct from p_expected_owner then
    return jsonb_build_object('ok',false,'reason','owner_mismatch');
  end if;
  return jsonb_build_object('ok',true,'sid',p_sid,'receiptOwner',v_receipt.manager_user_id,
    'owner',v_owner,'status',v_receipt.status,'body',v_body,'fromPhone',v_from,'toPhone',v_to,
    'occurredAt',v_receipt.first_received_at,'role',v_role,'userId',v_user,
    'conversationKey',v_key,'workLineId',v_line_id,'ingress',v_ingress_count=1,
    'source',case when v_receipt.inbound_payload is null then 'durable_log' else 'receipt_payload' end);
end $$;
revoke all on function public.resolve_sms_completed_receipt_original(text,uuid) from public, anon, authenticated;
grant execute on function public.resolve_sms_completed_receipt_original(text,uuid) to service_role;
