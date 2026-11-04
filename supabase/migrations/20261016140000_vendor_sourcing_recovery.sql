alter table public.sms_outbox add column if not exists sourcing_retry_generation integer not null default 0 check(sourcing_retry_generation>=0);
-- Explicit manager recovery only. Never re-arm an ambiguous provider outcome.
create or replace function public.control_vendor_sourcing(p_work_order_id text,p_manager_user_id uuid,p_action text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.vendor_sourcing_jobs; c public.vendor_sourcing_candidates; o public.sms_outbox;
begin
 if p_action not in ('start','pause','resume') then return false; end if;
 select * into j from public.vendor_sourcing_jobs where work_order_id=p_work_order_id and manager_user_id=p_manager_user_id for update;
 if not found or j.state='complete' then return false; end if;
 if p_action='pause' then
  if j.state not in ('queued','sourcing','waiting','quote_collected','needs_attention') then return false; end if;
 else
  if (p_action='start' and j.state<>'dormant') or (p_action='resume' and j.state not in ('paused','needs_attention')) then return false; end if;
  if not exists(select 1 from public.portal_work_order_records where id=p_work_order_id and manager_user_id=p_manager_user_id and row_data->>'bucket'='open' and nullif(row_data->>'vendorId','') is null and coalesce(row_data->>'selfAssigned','false')<>'true')
   or exists(select 1 from public.vendor_coordination_proposals where work_order_id=p_work_order_id and (manager_takeover or status='approved')) then return false; end if;
  for c in select * from public.vendor_sourcing_candidates where job_id=j.id and status in ('blocked','failed') for update loop
   -- Only operational pre-send failures are recoverable; opt-out, decline and expiry remain terminal.
   if c.reason not in ('runtime_env_paused','runtime_paused','manager_not_allowlisted','number_not_active','number_not_attached','number_not_registered','provider_identity_mismatch','outbox_scheduler_unready','provider_unavailable','insufficient_credit','insufficient_balance','credit_unavailable','credit_exhausted','credit_already_reserved','billing_paused','allowance_exhausted') then continue; end if;
   if c.expires_at<=now() then continue; end if;
   if c.outbox_id is null then
    update public.vendor_sourcing_candidates set status='discovered',reason=null,updated_at=now() where id=c.id;
   else
    select * into o from public.sms_outbox where id=c.outbox_id and manager_user_id=p_manager_user_id for update;
    if not found or o.purpose<>'vendor_quote_request' or o.dedupe_key<>'vendor-quote:'||p_work_order_id||':'||c.dedupe_key
      or o.status not in ('blocked','failed') or o.provider_message_sid is not null then continue; end if;
    if exists(select 1 from public.sms_delivery_attempts where outbox_id=o.id and (state<>'pre_dispatch_failed' or provider_message_sid is not null)) then continue; end if;
    if o.dispatch_started_at is not null and not exists(select 1 from public.sms_delivery_attempts where outbox_id=o.id and state='pre_dispatch_failed') then continue; end if;
    update public.sms_outbox set status='queued',sourcing_retry_generation=sourcing_retry_generation+1,blocked_reason=null,available_at=now(),dispatch_started_at=null,lease_owner=null,lease_expires_at=null,updated_at=now() where id=o.id;
    update public.vendor_sourcing_candidates set status='queued',reason=null,updated_at=now() where id=c.id;
   end if;
  end loop;
 end if;
 update public.vendor_sourcing_jobs set state=case when p_action='pause' then 'paused' else 'queued' end,
  reason=case when p_action='pause' then 'Paused by manager' else null end,next_run_at=now(),lease_token=null,lease_until=null,attempts=0,updated_at=now() where id=j.id;
 return true;
end $$;
revoke all on function public.control_vendor_sourcing(text,uuid,text) from public,anon,authenticated;
grant execute on function public.control_vendor_sourcing(text,uuid,text) to service_role;
