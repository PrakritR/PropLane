-- One job is never paid twice across rails.
--
-- 20261004140000 replaced the one-payout-per-work-order unique index with
-- (work_order_id, coalesce(invoice_id, zero-uuid)) so a service can carry the job's own
-- payout AND the estimate-visit fee's. That is looser by design, but it also removed the
-- database arbitration between the two rails that pay the SAME job:
--   * the invoice rail   (claim_vendor_invoice_payment -> vendor_payouts.invoice_id = <job invoice>)
--   * the Approve + pay  (vendor_payouts.invoice_id is null)
-- so "Approve + pay" followed by paying the vendor's own job invoice (or the reverse, or a
-- double click / two tabs) inserted a second payout and paid the vendor twice.
--
-- This migration restores that arbitration, additively and idempotently:
--   1. vendor_payout_cross_rail_conflict(): takes a per-work-order advisory transaction
--      lock, then answers whether a pending/paid payout of the OTHER rail already exists.
--      An estimate-visit-fee invoice (estimate_visit_bid_id set, server-written only) is a
--      separate bill and never conflicts, in either direction.
--   2. claim_vendor_invoice_payment() (same signature, grants and security settings) calls
--      it before its insert.
--   3. A BEFORE INSERT/UPDATE trigger on vendor_payouts calls it for every other writer
--      (Approve + pay's checkout, transfer and balance rails), so the check and the insert
--      are one transaction no matter which code path writes the row. A payout that is already
--      pending/paid and only changes status (pending -> paid) is not re-checked.
--   4. One estimate-visit-fee invoice per bid, keyed on the server-written marker rather than
--      on the vendor-editable invoice number.
create or replace function public.vendor_payout_cross_rail_conflict(p_work_order text, p_invoice uuid, p_self uuid default null)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_visit_fee boolean := false;
begin
 if p_work_order is null then return false; end if;
 perform pg_advisory_xact_lock(hashtextextended('vendor_payout:' || p_work_order, 0));
 if p_invoice is not null then
   select (estimate_visit_bid_id is not null) into v_visit_fee from public.vendor_invoices where id = p_invoice;
   if coalesce(v_visit_fee, false) then return false; end if;
 end if;
 return exists (
   select 1
     from public.vendor_payouts p
     left join public.vendor_invoices vi on vi.id = p.invoice_id
    where p.work_order_id = p_work_order
      and p.status in ('pending','paid')
      and (p_self is null or p.id <> p_self)
      and case
            -- a job invoice is being paid: an invoice-less (Approve + pay) payout already covers the job
            when p_invoice is not null then p.invoice_id is null
            -- Approve + pay is paying: a payout on the job's own (non-visit-fee) invoice already covers it
            else p.invoice_id is not null and vi.estimate_visit_bid_id is null
          end
 );
end $$;
revoke all on function public.vendor_payout_cross_rail_conflict(text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.vendor_payout_cross_rail_conflict(text,uuid,uuid) to service_role;

create or replace function public.claim_vendor_invoice_payment(p_invoice uuid, p_manager uuid, p_rail text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare i public.vendor_invoices; w public.portal_work_order_records;
begin
 if p_rail not in ('stripe','balance','offline') then raise exception 'Invalid payment source'; end if;
 select * into i from public.vendor_invoices where id=p_invoice and manager_user_id=p_manager for update;
 if not found or i.voided_at is not null then raise exception 'Invoice not found'; end if;
 if i.status not in ('approved','scheduled','paid') then raise exception 'Invoice must be approved'; end if;
 if i.payment_claim is not null and i.payment_claim <> p_rail then raise exception 'Payment already started using another source'; end if;
 if i.status='paid' and i.payment_claim is null then raise exception 'Invoice already paid'; end if;
 if i.work_order_id is null then raise exception 'Invoice requires an assigned service'; end if;
 select * into w from public.portal_work_order_records where id=i.work_order_id and manager_user_id=p_manager;
 if not found or (i.status <> 'paid' and w.vendor_user_id is distinct from i.vendor_user_id) then raise exception 'Service is not assigned to this vendor'; end if;
 if i.total_cents <= 0 or i.bill_id is null then raise exception 'Invoice has no approved bill'; end if;
 -- The (work order, invoice) unique index only arbitrates two claims on the SAME invoice. A payout
 -- from the other rail (Approve + pay has invoice_id null) is arbitrated here, under a per-work-order
 -- lock so a concurrent Approve + pay cannot slip in between this check and the insert. A visit-fee
 -- invoice is a separate bill and is exempt (see vendor_payout_cross_rail_conflict).
 if i.payment_claim is null then
   if public.vendor_payout_cross_rail_conflict(i.work_order_id, i.id, null) then
     raise exception 'This service has already been paid through Approve + pay. Paying this invoice would pay the vendor twice.' using errcode = 'VP409';
   end if;
   insert into public.vendor_payouts(manager_user_id,vendor_user_id,work_order_id,invoice_id,amount_cents,status)
   values(p_manager,i.vendor_user_id,i.work_order_id,i.id,i.total_cents,'pending');
   update public.vendor_invoices set payment_claim=p_rail, updated_at=now() where id=i.id;
 end if;
 return jsonb_build_object('status',i.status,'totalCents',i.total_cents,'vendorUserId',i.vendor_user_id,'billId',i.bill_id);
end $$;
revoke all on function public.claim_vendor_invoice_payment(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.claim_vendor_invoice_payment(uuid,uuid,text) to service_role;

create or replace function public.vendor_payouts_cross_rail_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
 if new.work_order_id is null or new.status not in ('pending','paid') then return new; end if;
 -- Already a money-moving payout for the same job and invoice: a pending -> paid settle, nothing new to check.
 if tg_op = 'UPDATE'
    and old.status in ('pending','paid')
    and old.work_order_id is not distinct from new.work_order_id
    and old.invoice_id is not distinct from new.invoice_id then
   return new;
 end if;
 if public.vendor_payout_cross_rail_conflict(new.work_order_id, new.invoice_id, new.id) then
   raise exception 'This service already has a payout in progress or paid through another payment method. Paying it again would pay the vendor twice.' using errcode = 'VP409';
 end if;
 return new;
end $$;
revoke all on function public.vendor_payouts_cross_rail_guard() from public,anon,authenticated;

drop trigger if exists vendor_payouts_cross_rail_guard on public.vendor_payouts;
create trigger vendor_payouts_cross_rail_guard
  before insert or update on public.vendor_payouts
  for each row execute function public.vendor_payouts_cross_rail_guard();

-- One estimate-visit-fee invoice per bid. The marker is written only by the server-side
-- visit-fee flow, so unlike the VISIT-<bid> invoice number it cannot be edited away.
create unique index if not exists vendor_invoices_estimate_visit_bid_unique
  on public.vendor_invoices (estimate_visit_bid_id)
  where estimate_visit_bid_id is not null;
