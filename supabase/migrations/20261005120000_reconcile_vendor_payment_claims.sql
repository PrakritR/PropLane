-- Reconciles two lines of work on the same functions. `claim_vendor_invoice_payment` and
-- `claim_work_order_vendor_payment` were last defined by 20261004220000 (which DEV already has),
-- written before the server-written estimate-visit marker (20261004150000) and the cross-rail
-- payout guard (20261004160000) landed from the prakrit rung. Redefining them here keeps ONE
-- arbitration: the same `vendor_payout_cross_rail_conflict` lock + the `vendor_payouts` trigger,
-- and a visit-fee invoice decided by `estimate_visit_bid_id`, never by a vendor-typed invoice
-- number. Additive, idempotent (`create or replace`), signatures and grants unchanged.

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
   -- Server-written marker (migration 20261004150000), never the vendor-editable invoice number.
   is_visit_fee := i.estimate_visit_bid_id is not null;
   if i.status <> 'paid' and w.vendor_user_id is distinct from i.vendor_user_id and not is_visit_fee then raise exception 'Service is not assigned to this vendor'; end if;
 end if;
 if i.total_cents <= 0 or i.bill_id is null then raise exception 'Invoice has no approved bill'; end if;
 if i.payment_claim is null then
   -- One job is never paid twice across rails (migration 20261004160000): the per-work-order lock
   -- inside the conflict check serialises this claim against an Approve + pay claim.
   if not is_visit_fee and i.work_order_id is not null and
      public.vendor_payout_cross_rail_conflict(i.work_order_id, i.id, null) then
     raise exception 'This service has already been paid through Approve + pay. Paying this invoice would pay the vendor twice.' using errcode = 'VP409';
   end if;
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
     and i.estimate_visit_bid_id is null
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
