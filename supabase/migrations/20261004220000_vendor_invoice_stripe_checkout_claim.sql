-- A direct invoice can have no service. Keep the existing service assignment and
-- work-order payout arbitration for linked invoices, but claim standalone bills too.
create or replace function public.claim_vendor_invoice_payment(p_invoice uuid, p_manager uuid, p_rail text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare i public.vendor_invoices; w public.portal_work_order_records; p public.vendor_payouts; is_visit_fee boolean := false;
begin
 if p_rail not in ('stripe','balance','offline') then raise exception 'Invalid payment source'; end if;
 select * into i from public.vendor_invoices where id=p_invoice and manager_user_id=p_manager for update;
 if not found or i.voided_at is not null then raise exception 'Invoice not found'; end if;
 if i.status not in ('approved','scheduled') and not (i.status='paid' and i.payment_claim=p_rail) then raise exception 'Invoice must be approved'; end if;
 if i.payment_claim is not null and i.payment_claim <> p_rail then raise exception 'Payment already started using another source'; end if;
 if i.work_order_id is not null then
   select * into w from public.portal_work_order_records where id=i.work_order_id and manager_user_id=p_manager;
   if not found then raise exception 'Service not found'; end if;
   select exists (
     select 1 from public.work_order_bids b where
       i.invoice_number = 'VISIT-' || b.id::text and
       b.work_order_id = i.work_order_id and b.vendor_user_id = i.vendor_user_id and
       b.manager_user_id = p_manager and b.estimate_visit_done_at is not null and
       b.estimate_visit_fee_cents > 0 and b.estimate_visit_fee_cents = i.total_cents
   ) into is_visit_fee;
   if i.status <> 'paid' and w.vendor_user_id is distinct from i.vendor_user_id and not is_visit_fee then raise exception 'Service is not assigned to this vendor'; end if;
 end if;
 if i.total_cents <= 0 or i.bill_id is null then raise exception 'Invoice has no approved bill'; end if;
 if i.payment_claim is null then
   select * into p from public.vendor_payouts where invoice_id=i.id for update;
   if found then
     if p.status not in ('failed','skipped') or p.manager_user_id<>p_manager or p.vendor_user_id<>i.vendor_user_id then raise exception 'Invoice payout already exists'; end if;
     update public.vendor_payouts set status='pending',amount_cents=i.total_cents,
       work_order_id=case when is_visit_fee then null else i.work_order_id end,
       failure_reason=null,stripe_transfer_id=null,updated_at=now() where id=p.id;
   else
     insert into public.vendor_payouts(manager_user_id,vendor_user_id,work_order_id,invoice_id,amount_cents,status)
     values(p_manager,i.vendor_user_id,case when is_visit_fee then null else i.work_order_id end,i.id,i.total_cents,'pending');
   end if;
   update public.vendor_invoices set payment_claim=p_rail, updated_at=now() where id=i.id;
 end if;
 return jsonb_build_object('status',i.status,'totalCents',i.total_cents,'vendorUserId',i.vendor_user_id,'billId',i.bill_id);
end $$;
revoke all on function public.claim_vendor_invoice_payment(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.claim_vendor_invoice_payment(uuid,uuid,text) to service_role;

-- One stable Stripe attempt token, including its method, is stored before the
-- external API call. A retry reuses the same Stripe idempotency key.
alter table public.vendor_invoices
  add column if not exists stripe_checkout_provider_terms jsonb;

-- Freeze the exact provider request before Stripe is called. A concurrent
-- retry must use the winning frozen request, not re-read bank readiness, fee
-- flags, labels or return origin with the same Stripe idempotency key.
create or replace function public.freeze_vendor_invoice_stripe_checkout_terms(
  p_invoice uuid,p_manager uuid,p_attempt text,p_terms jsonb
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare i public.vendor_invoices; request jsonb;
begin
 select * into i from public.vendor_invoices where id=p_invoice and manager_user_id=p_manager for update;
 if not found or i.payment_claim is distinct from 'stripe' or
    i.checkout_session_id is distinct from p_attempt or
    p_attempt !~ '^attempt:(card|ach):[0-9a-f-]{36}$' then
   raise exception 'Invoice checkout claim is not current'; end if;
 if i.stripe_checkout_provider_terms is not null then
   return i.stripe_checkout_provider_terms;
 end if;
 request:=p_terms->'request';
 if p_terms is null or jsonb_typeof(p_terms)<>'object' or
    jsonb_typeof(request)<>'object' or
    p_terms->>'invoiceId' is distinct from i.id::text or
    p_terms->>'managerUserId' is distinct from p_manager::text or
    p_terms->>'vendorUserId' is distinct from i.vendor_user_id::text or
    (p_terms->>'invoiceCents')::integer is distinct from i.total_cents or
    request->>'paymentMethod' is distinct from split_part(p_attempt,':',2) or
    request->>'idempotencyKey' is distinct from
      'vendor-invoice:'||i.id::text||':'||p_attempt or
    request->>'amountCents' is distinct from i.total_cents::text or
    request->>'destinationAccountId' is not null or
    request->'metadata'->>'source_arbitration_v' is distinct from '1' or
    request->'metadata'->>'checkout_attempt' is distinct from p_attempt or
    request->'metadata'->>'invoice_id' is distinct from i.id::text or
    request->'metadata'->>'manager_user_id' is distinct from p_manager::text or
    request->'metadata'->>'vendor_user_id' is distinct from i.vendor_user_id::text or
    request->'metadata'->>'invoice_cents' is distinct from i.total_cents::text or
    request->>'feePayer' is distinct from 'resident' then
   raise exception 'Invoice checkout provider terms differ from claim'; end if;
 update public.vendor_invoices set stripe_checkout_provider_terms=p_terms,updated_at=now()
   where id=i.id;
 return p_terms;
end $$;
revoke all on function public.freeze_vendor_invoice_stripe_checkout_terms(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.freeze_vendor_invoice_stripe_checkout_terms(uuid,uuid,text,jsonb) to service_role;

create or replace function public.claim_vendor_invoice_stripe_checkout(p_invoice uuid, p_manager uuid, p_attempt text)
returns text language plpgsql security definer set search_path = public as $$
declare i public.vendor_invoices;
begin
 if p_attempt !~ '^attempt:(card|ach):[0-9a-f-]{36}$' then raise exception 'Invalid checkout attempt'; end if;
 perform public.claim_vendor_invoice_payment(p_invoice,p_manager,'stripe');
 select * into i from public.vendor_invoices where id=p_invoice and manager_user_id=p_manager for update;
 if i.payment_claim is distinct from 'stripe' or i.status='paid' then raise exception 'Payment claim mismatch'; end if;
 if i.checkout_session_id is null then
   update public.vendor_invoices set checkout_session_id=p_attempt,
     stripe_checkout_provider_terms=null,updated_at=now() where id=i.id;
   return p_attempt;
 end if;
 return i.checkout_session_id;
end $$;
revoke all on function public.claim_vendor_invoice_stripe_checkout(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.claim_vendor_invoice_stripe_checkout(uuid,uuid,text) to service_role;

-- Called only after Stripe confirms a terminal session state. The matching
-- session condition prevents an old webhook from releasing a newer attempt.
create or replace function public.release_vendor_invoice_stripe_checkout(p_invoice uuid,p_manager uuid,p_session text)
returns boolean language plpgsql security definer set search_path=public as $$
declare i public.vendor_invoices;
begin
 select * into i from public.vendor_invoices where id=p_invoice and manager_user_id=p_manager for update;
 if not found or i.status='paid' or i.payment_claim is distinct from 'stripe' or i.checkout_session_id is distinct from p_session then return false; end if;
 delete from public.vendor_payouts where invoice_id=i.id and manager_user_id=p_manager and status='pending';
 update public.vendor_invoices set payment_claim=null,checkout_session_id=null,
   stripe_checkout_provider_terms=null,updated_at=now() where id=i.id;
 return true;
end $$;
revoke all on function public.release_vendor_invoice_stripe_checkout(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.release_vendor_invoice_stripe_checkout(uuid,uuid,text) to service_role;

-- Service payment claims lock the service row before inserting the one payout.
-- This arbitrates a balance move against a concurrent Stripe Checkout start.
create or replace function public.claim_work_order_vendor_payment(
  p_work_order text,p_manager uuid,p_vendor uuid,p_amount integer,p_channel text,p_pending jsonb default null)
returns void language plpgsql security definer set search_path=public as $$
declare w public.portal_work_order_records; p public.vendor_payouts;
begin
 if p_channel not in ('card','ach','balance') or p_amount < 100 then raise exception 'Invalid vendor payment'; end if;
 select * into w from public.portal_work_order_records where id=p_work_order and manager_user_id=p_manager for update;
 if not found or w.vendor_user_id is distinct from p_vendor then raise exception 'Service payment owner mismatch'; end if;
 if (w.row_data->>'automationStatus'='paid' or w.row_data->>'paidAt' is not null) and
    p_channel='balance' and w.row_data->>'pendingBalancePay'='work-order:'||p_work_order then
   select * into p from public.vendor_payouts where work_order_id=p_work_order for update;
   if found and p.status in ('pending','paid','partially_refunded','refunded') and
      p.manager_user_id=p_manager and p.vendor_user_id=p_vendor and p.amount_cents=p_amount and
      exists(select 1 from public.proplane_balance_entries e
        join public.proplane_balance_accounts a on a.id=e.account_id
        where e.idempotency_key='work-order:'||p_work_order||':out'
          and e.kind='vendor_payment_out' and e.amount_cents=-p_amount
          and a.owner_kind='workspace' and a.owner_key=p_manager::text and a.currency='usd')
   then return; end if;
 end if;
 if w.row_data->>'automationStatus'='paid' or w.row_data->>'paidAt' is not null then raise exception 'Service already paid'; end if;
 if exists (
   select 1 from public.vendor_invoices i where i.work_order_id=p_work_order and i.manager_user_id=p_manager
     and i.vendor_user_id=p_vendor and i.status in ('approved','scheduled') and i.voided_at is null
     and not exists (
       select 1 from public.work_order_bids b where i.invoice_number='VISIT-'||b.id::text
         and b.work_order_id=p_work_order and b.vendor_user_id=i.vendor_user_id
         and b.manager_user_id=p_manager and b.estimate_visit_done_at is not null
         and b.estimate_visit_fee_cents=i.total_cents and b.estimate_visit_fee_cents>0
     )
 ) then raise exception 'Pay the approved service invoice instead'; end if;
 if p_channel in ('card','ach') and (p_pending is null or p_pending->>'sessionId' !~ '^attempt:[0-9a-f-]{36}$') then raise exception 'Missing checkout attempt'; end if;
 if p_channel in ('card','ach') and (
    p_pending->'providerTerms'->>'managerUserId' is distinct from p_manager::text or
    p_pending->'providerTerms'->>'vendorUserId' is distinct from p_vendor::text or
    p_pending->'providerTerms'->>'invoiceCents' is distinct from p_amount::text or
    p_pending->'providerTerms'->'request'->>'amountCents' is distinct from p_amount::text or
    p_pending->'providerTerms'->'request'->>'idempotencyKey' is distinct from
      'work-order:'||p_work_order||':'||(p_pending->>'sessionId') or
    p_pending->'providerTerms'->'request'->>'destinationAccountId' is not null or
    p_pending->'providerTerms'->'request'->>'paymentMethod' is distinct from p_channel or
    p_pending->'providerTerms'->'request'->'metadata'->>'source_arbitration_v' is distinct from '1' or
    p_pending->'providerTerms'->'request'->'metadata'->>'checkout_attempt' is distinct from p_pending->>'sessionId' or
    p_pending->'providerTerms'->'request'->'metadata'->>'manager_user_id' is distinct from p_manager::text or
    p_pending->'providerTerms'->'request'->'metadata'->>'vendor_user_id' is distinct from p_vendor::text or
    p_pending->'providerTerms'->'request'->'metadata'->>'invoice_cents' is distinct from p_amount::text
  ) then raise exception 'Service Checkout provider terms differ from claim'; end if;
 if w.row_data ? 'pendingVendorPay' or w.row_data ? 'pendingBalancePay' then
   if p_channel='balance' and w.row_data->>'pendingBalancePay'='work-order:'||p_work_order then
     select * into p from public.vendor_payouts where work_order_id=p_work_order for update;
     if found and p.status='pending' and p.manager_user_id=p_manager and p.vendor_user_id=p_vendor and p.amount_cents=p_amount then return; end if;
   end if;
   raise exception 'Payment already started';
 end if;
 select * into p from public.vendor_payouts where work_order_id=p_work_order for update;
 if found then
   if p.status not in ('failed','skipped') or p.manager_user_id<>p_manager or p.vendor_user_id<>p_vendor then raise exception 'Service payout already exists'; end if;
   update public.vendor_payouts set status='pending',amount_cents=p_amount,
     failure_reason=null,stripe_transfer_id=null,updated_at=now() where id=p.id;
 else
   insert into public.vendor_payouts(manager_user_id,vendor_user_id,work_order_id,amount_cents,status)
   values(p_manager,p_vendor,p_work_order,p_amount,'pending');
 end if;
 if p_channel in ('card','ach') then
   update public.portal_work_order_records set row_data=jsonb_set(w.row_data,'{pendingVendorPay}',p_pending,true),updated_at=now() where id=p_work_order;
 else
   update public.portal_work_order_records set row_data=jsonb_set(w.row_data,'{pendingBalancePay}',to_jsonb('work-order:'||p_work_order),true),updated_at=now() where id=p_work_order;
 end if;
end $$;
revoke all on function public.claim_work_order_vendor_payment(text,uuid,uuid,integer,text,jsonb) from public,anon,authenticated;
grant execute on function public.claim_work_order_vendor_payment(text,uuid,uuid,integer,text,jsonb) to service_role;

create or replace function public.finish_work_order_vendor_checkout(
  p_work_order text,p_manager uuid,p_attempt text,p_session text)
returns boolean language plpgsql security definer set search_path=public as $$
declare w public.portal_work_order_records;
begin
 select * into w from public.portal_work_order_records where id=p_work_order and manager_user_id=p_manager for update;
 if not found or w.row_data #>> '{pendingVendorPay,sessionId}' is distinct from p_attempt then return false; end if;
 update public.portal_work_order_records set row_data=jsonb_set(w.row_data,'{pendingVendorPay,sessionId}',to_jsonb(p_session),false),updated_at=now() where id=p_work_order;
 return true;
end $$;
revoke all on function public.finish_work_order_vendor_checkout(text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.finish_work_order_vendor_checkout(text,uuid,text,text) to service_role;

create or replace function public.release_work_order_vendor_checkout(
  p_work_order text,p_manager uuid,p_session text)
returns boolean language plpgsql security definer set search_path=public as $$
declare w public.portal_work_order_records;
begin
 select * into w from public.portal_work_order_records where id=p_work_order and manager_user_id=p_manager for update;
 if not found or w.row_data #>> '{pendingVendorPay,sessionId}' is distinct from p_session or
    w.row_data->>'automationStatus'='paid' or w.row_data->>'paidAt' is not null then return false; end if;
 delete from public.vendor_payouts where work_order_id=p_work_order and manager_user_id=p_manager and status='pending';
 update public.portal_work_order_records set row_data=w.row_data-'pendingVendorPay',updated_at=now() where id=p_work_order;
 return true;
end $$;
revoke all on function public.release_work_order_vendor_checkout(text,uuid,text) from public,anon,authenticated;
grant execute on function public.release_work_order_vendor_checkout(text,uuid,text) to service_role;

create or replace function public.release_work_order_balance_claim(p_work_order text,p_manager uuid)
returns boolean language plpgsql security definer set search_path=public as $$
declare w public.portal_work_order_records;
begin
 select * into w from public.portal_work_order_records where id=p_work_order and manager_user_id=p_manager for update;
 if not found or w.row_data->>'pendingBalancePay' is distinct from 'work-order:'||p_work_order or
    w.row_data->>'automationStatus'='paid' or w.row_data->>'paidAt' is not null then return false; end if;
 perform 1 from public.proplane_balance_accounts where owner_kind='workspace' and owner_key=p_manager::text and currency='usd' for update;
 if exists(select 1 from public.proplane_balance_entries where idempotency_key='work-order:'||p_work_order||':out') then return false; end if;
 delete from public.vendor_payouts where work_order_id=p_work_order and manager_user_id=p_manager and status='pending';
 update public.portal_work_order_records set row_data=w.row_data-'pendingBalancePay',updated_at=now() where id=p_work_order;
 return true;
end $$;
revoke all on function public.release_work_order_balance_claim(text,uuid) from public,anon,authenticated;
grant execute on function public.release_work_order_balance_claim(text,uuid) to service_role;

-- Pay bookkeeping merges only server-owned completion fields into the locked
-- current row. A stale client or webhook snapshot cannot erase a pending
-- session/ledger claim or change the resident/property/payee identity.
create or replace function public.mark_work_order_payment_paid(
  p_work_order text,p_manager uuid,p_vendor uuid,p_amount integer,p_channel text,p_session text,p_patch jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare w public.portal_work_order_records; p public.vendor_payouts; allowed jsonb; merged jsonb;
begin
 select * into w from public.portal_work_order_records where id=p_work_order and manager_user_id=p_manager for update;
 if not found or w.vendor_user_id is distinct from p_vendor or p_amount<100 then raise exception 'Service payment owner mismatch'; end if;
 select * into p from public.vendor_payouts where work_order_id=p_work_order for update;
 if not found or p.manager_user_id<>p_manager or p.vendor_user_id<>p_vendor or p.amount_cents<>p_amount or
   p.status not in ('pending','paid','partially_refunded','refunded') then raise exception 'Service payout claim mismatch'; end if;
 if p_channel='balance' then
   if w.row_data->>'pendingBalancePay' is distinct from 'work-order:'||p_work_order or
     not exists(select 1 from public.proplane_balance_entries e
       join public.proplane_balance_accounts a on a.id=e.account_id
       where e.idempotency_key='work-order:'||p_work_order||':out'
         and e.kind='vendor_payment_out' and e.amount_cents=-p_amount
         and a.owner_kind='workspace' and a.owner_key=p_manager::text and a.currency='usd')
   then raise exception 'Service balance payment is not funded'; end if;
 elsif p_channel in ('card','ach') then
   if p_session is null or w.row_data #>> '{pendingVendorPay,sessionId}' is distinct from p_session or
      (w.row_data #>> '{pendingVendorPay,vendorCostCents}')::integer is distinct from p_amount or
      (w.row_data #>> '{pendingVendorPay,providerTerms,request,paymentMethod}' is not null and
       w.row_data #>> '{pendingVendorPay,providerTerms,request,paymentMethod}' is distinct from p_channel)
   then raise exception 'Service Stripe payment claim mismatch'; end if;
 else raise exception 'Invalid service funding channel'; end if;
 select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) into allowed
 from jsonb_each(coalesce(p_patch,'{}'::jsonb)) where key=any(array[
   'bucket','status','category','vendorCostCents','materialsCostCents','materialsMemo',
   'workDoneSummary','completedAt','vendorPaymentChannel']);
 merged:=w.row_data || allowed || jsonb_build_object('automationStatus','paid',
   'paidAt',coalesce(w.row_data->>'paidAt',now()::text));
 if w.row_data ? 'completedAt' then merged:=jsonb_set(merged,'{completedAt}',w.row_data->'completedAt',true); end if;
 if p_patch ? 'expenseEntryIds' then
   merged:=jsonb_set(merged,'{expenseEntryIds}',(
     select coalesce(jsonb_agg(distinct value),'[]'::jsonb)
     from jsonb_array_elements_text(coalesce(w.row_data->'expenseEntryIds','[]'::jsonb) ||
       coalesce(p_patch->'expenseEntryIds','[]'::jsonb)) as ids(value)),true);
 end if;
 update public.portal_work_order_records set row_data=merged,updated_at=now() where id=p_work_order;
 return merged;
end $$;
revoke all on function public.mark_work_order_payment_paid(text,uuid,uuid,integer,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.mark_work_order_payment_paid(text,uuid,uuid,integer,text,text,jsonb) to service_role;

create or replace function public.complete_work_order_record(p_work_order text,p_manager uuid,p_patch jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare w public.portal_work_order_records; allowed jsonb; merged jsonb;
begin
 select * into w from public.portal_work_order_records where id=p_work_order and manager_user_id=p_manager for update;
 if not found then raise exception 'Service not found'; end if;
 if w.row_data ? 'pendingVendorPay' or w.row_data ? 'pendingBalancePay' or
    w.row_data->>'automationStatus'='paid' or w.row_data ? 'paidAt' then
   raise exception 'Service payment is already in progress or paid';
 end if;
 select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) into allowed
 from jsonb_each(coalesce(p_patch,'{}'::jsonb)) where key=any(array[
   'category','vendorCostCents','materialsCostCents','materialsMemo','workDoneSummary']);
 merged:=w.row_data || allowed || jsonb_build_object('bucket','completed','status','Completed',
   'completedAt',coalesce(w.row_data->'completedAt',to_jsonb(now()::text)));
 update public.portal_work_order_records set row_data=merged,updated_at=now() where id=p_work_order;
 return merged;
end $$;
revoke all on function public.complete_work_order_record(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.complete_work_order_record(text,uuid,jsonb) to service_role;

create or replace function public.release_vendor_invoice_balance_claim(p_invoice uuid,p_manager uuid)
returns boolean language plpgsql security definer set search_path=public as $$
declare i public.vendor_invoices;
begin
 select * into i from public.vendor_invoices where id=p_invoice and manager_user_id=p_manager for update;
 if not found or i.status='paid' or i.payment_claim is distinct from 'balance' then return false; end if;
 perform 1 from public.proplane_balance_accounts where owner_kind='workspace' and owner_key=p_manager::text and currency='usd' for update;
 if exists(select 1 from public.proplane_balance_entries where idempotency_key='vendor-invoice:'||p_invoice||':out') then return false; end if;
 delete from public.vendor_payouts where invoice_id=p_invoice and manager_user_id=p_manager and status='pending';
 update public.vendor_invoices set payment_claim=null,updated_at=now() where id=p_invoice;
 return true;
end $$;
revoke all on function public.release_vendor_invoice_balance_claim(uuid,uuid) from public,anon,authenticated;
grant execute on function public.release_vendor_invoice_balance_claim(uuid,uuid) to service_role;

-- A concurrent replay of one balance move may see no debit before waiting for
-- the account locks. Recheck under those locks before testing available funds.
create or replace function public.proplane_balance_move(
  p_payer_account_id uuid,p_payee_account_id uuid,p_amount_cents bigint,
  p_payer_kind text,p_payee_kind text,p_idempotency_root text)
returns table(payer_entry_id uuid,payee_entry_id uuid)
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_out text := p_idempotency_root||':out'; v_in text := p_idempotency_root||':in';
  v_payer uuid; v_payee uuid; v_available bigint; v_first uuid; v_second uuid;
  out_entry public.proplane_balance_entries; in_entry public.proplane_balance_entries;
begin
 if p_amount_cents is null or p_amount_cents<=0 or p_payer_account_id=p_payee_account_id then raise exception 'Invalid balance move'; end if;
 if p_payer_account_id<p_payee_account_id then v_first:=p_payer_account_id;v_second:=p_payee_account_id;
 else v_first:=p_payee_account_id;v_second:=p_payer_account_id;end if;
 perform 1 from public.proplane_balance_accounts where id=v_first for update;
 perform 1 from public.proplane_balance_accounts where id=v_second for update;
 select id into v_payer from public.proplane_balance_entries where idempotency_key=v_out;
 if found then
   select * into out_entry from public.proplane_balance_entries where idempotency_key=v_out;
   select * into in_entry from public.proplane_balance_entries where idempotency_key=v_in;
   if in_entry.id is null or out_entry.account_id<>p_payer_account_id or
      in_entry.account_id<>p_payee_account_id or out_entry.amount_cents<>-p_amount_cents or
      in_entry.amount_cents<>p_amount_cents or out_entry.kind<>p_payer_kind or
      in_entry.kind<>p_payee_kind or out_entry.related_entry_id is distinct from in_entry.id or
      in_entry.related_entry_id is distinct from out_entry.id then
     raise exception 'Balance move replay terms differ';
   end if;
   v_payee:=in_entry.id;
   return query select v_payer,v_payee; return;
 end if;
 select coalesce(sum(amount_cents),0) into v_available from public.proplane_balance_entries
 where account_id=p_payer_account_id and status='available';
 if v_available<p_amount_cents then raise exception 'INSUFFICIENT_BALANCE: available=% requested=%',v_available,p_amount_cents;end if;
 insert into public.proplane_balance_entries(account_id,amount_cents,kind,status,available_on,idempotency_key)
 values(p_payer_account_id,-p_amount_cents,p_payer_kind,'available',now(),v_out) returning id into v_payer;
 insert into public.proplane_balance_entries(account_id,amount_cents,kind,status,available_on,idempotency_key,related_entry_id)
 values(p_payee_account_id,p_amount_cents,p_payee_kind,'available',now(),v_in,v_payer) returning id into v_payee;
 update public.proplane_balance_entries set related_entry_id=v_payee where id=v_payer;
 return query select v_payer,v_payee;
end $$;
revoke all on function public.proplane_balance_move(uuid,uuid,bigint,text,text,text) from public,anon,authenticated;
grant execute on function public.proplane_balance_move(uuid,uuid,bigint,text,text,text) to service_role;

-- A paid service has one cash expense per component. Completion does not book
-- cash; webhook replay repairs a missing GL journal against the same expense.
alter table public.manager_expense_entries add column if not exists source_work_order_component text;
create unique index if not exists manager_expense_service_component_unique
  on public.manager_expense_entries(manager_user_id,source_work_order_id,source_work_order_component)
  where source_work_order_component is not null;

-- Owned-expense RLS still permits ordinary manual entries. These linked paid
-- source keys are reserved for service-role settlement and cannot be forged
-- or edited through the public authenticated PostgREST surface.
create or replace function public.guard_paid_expense_source_write()
returns trigger language plpgsql set search_path=public as $$
begin
 if current_user in ('anon','authenticated') then
   if tg_op='DELETE' then
     if old.source_work_order_component is not null or old.source_vendor_invoice_id is not null then
       raise exception 'Payment expense source is server-owned';
     end if;
     return old;
   end if;
   if new.source_work_order_component is not null or new.source_vendor_invoice_id is not null then
     raise exception 'Payment expense source is server-owned';
   end if;
   if tg_op='UPDATE' then
     if old.source_work_order_component is not null or old.source_vendor_invoice_id is not null then
       raise exception 'Payment expense source is server-owned';
     end if;
   end if;
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;
drop trigger if exists guard_paid_expense_source_write on public.manager_expense_entries;
create trigger guard_paid_expense_source_write before insert or update or delete on public.manager_expense_entries
for each row execute function public.guard_paid_expense_source_write();

create or replace function public.ensure_paid_work_order_expense(
  p_manager uuid,p_work_order text,p_component text,p_amount bigint,p_category text,
  p_date date,p_property text,p_vendor text,p_memo text,p_deductible boolean)
returns uuid language plpgsql security definer set search_path=public as $$
declare e public.manager_expense_entries; w public.portal_work_order_records;
begin
 if p_component not in ('labor','materials') or p_amount<=0 then raise exception 'Invalid paid expense'; end if;
 select * into w from public.portal_work_order_records where id=p_work_order and manager_user_id=p_manager;
 if not found then raise exception 'Service not found'; end if;
 insert into public.manager_expense_entries(manager_user_id,property_id,vendor_id,category_code,
   amount_cents,expense_date,memo,tax_deductible,source_work_order_id,source_work_order_component,updated_at)
 values(p_manager,p_property,p_vendor,p_category,p_amount,p_date,p_memo,p_deductible,p_work_order,p_component,now())
 on conflict (manager_user_id,source_work_order_id,source_work_order_component)
 where source_work_order_component is not null do nothing;
 select * into e from public.manager_expense_entries where manager_user_id=p_manager
   and source_work_order_id=p_work_order and source_work_order_component=p_component;
 if not found or e.amount_cents<>p_amount or e.category_code<>p_category or
    e.property_id is distinct from p_property or e.vendor_id is distinct from p_vendor then
   raise exception 'Paid expense differs from settled service';
 end if;
 return e.id;
end $$;
revoke all on function public.ensure_paid_work_order_expense(uuid,text,text,bigint,text,date,text,text,text,boolean) from public,anon,authenticated;
grant execute on function public.ensure_paid_work_order_expense(uuid,text,text,bigint,text,date,text,text,text,boolean) to service_role;

-- Invoice approval already posted expense/AP. Settlement creates one paid
-- expense record and the caller posts AP/cash against the stable bill id.
create or replace function public.settle_vendor_invoice_payment(
  p_invoice uuid,p_manager uuid,p_rail text,p_paid_at timestamptz default now(),p_method text default null)
returns uuid language plpgsql security definer set search_path=public as $$
declare i public.vendor_invoices; b public.manager_bills; p public.vendor_payouts; expense_id uuid;
begin
 select * into i from public.vendor_invoices where id=p_invoice and manager_user_id=p_manager for update;
 if not found or i.payment_claim is distinct from p_rail or i.voided_at is not null or i.currency<>'usd' then raise exception 'Payment claim mismatch'; end if;
 if i.status not in ('approved','scheduled','paid') then raise exception 'Invoice is not approved'; end if;
 select * into b from public.manager_bills where id=i.bill_id and manager_user_id=p_manager for update;
 if not found or b.amount_cents<>i.total_cents or b.status='void' or
    b.vendor_id is distinct from i.vendor_id or b.vendor_invoice_id is distinct from i.id or
    b.work_order_id is distinct from i.work_order_id then raise exception 'Bill mismatch'; end if;
 select * into p from public.vendor_payouts where invoice_id=i.id for update;
 if not found or p.manager_user_id<>p_manager or p.vendor_user_id<>i.vendor_user_id or
    p.amount_cents<>i.total_cents or p.status not in ('pending','paid','partially_refunded','refunded') then raise exception 'Payout mismatch'; end if;
 expense_id:=b.paid_expense_entry_id;
 if expense_id is null then
   insert into public.manager_expense_entries(manager_user_id,property_id,vendor_id,category_code,
     amount_cents,expense_date,memo,source_work_order_id,source_vendor_invoice_id)
   values(p_manager,b.property_id,b.vendor_id,b.category_code,b.amount_cents,
     (p_paid_at at time zone 'America/Los_Angeles')::date,'Bill paid — '||b.description,b.work_order_id,i.id)
   returning id into expense_id;
 end if;
 update public.manager_bills set status='paid',paid_at=coalesce(paid_at,p_paid_at),
   paid_expense_entry_id=expense_id,updated_at=now() where id=b.id;
 update public.vendor_invoices set status='paid',paid_at=coalesce(paid_at,p_paid_at),
   paid_from=case when p_rail='offline' then null else p_rail end,
   offline_method=case when p_rail='offline' then p_method else offline_method end,updated_at=now() where id=i.id;
 update public.vendor_payouts set status=case when p.status in ('partially_refunded','refunded') then p.status else 'paid' end,
   updated_at=now() where id=p.id;
 return b.id;
end $$;
revoke all on function public.settle_vendor_invoice_payment(uuid,uuid,text,timestamptz,text) from public,anon,authenticated;
grant execute on function public.settle_vendor_invoice_payment(uuid,uuid,text,timestamptz,text) to service_role;
