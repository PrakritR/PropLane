-- Which vendor invoice is an estimate-visit fee is a SERVER decision, not a string a
-- vendor types. `invoice_number` arrives verbatim in the vendor's own submission body,
-- so a `VISIT-` prefix there is vendor-controlled input: the assigned vendor could number
-- their own $500 job bill `VISIT-x` and have the double-pay guard and the job-expense
-- guard both wave it through. This column is written only by the server-side visit-fee
-- flow (`ensureVisitFeeInvoice`); nothing a vendor or manager submits can set it.
--
-- Additive and idempotent.
alter table public.vendor_invoices
  add column if not exists estimate_visit_bid_id uuid references public.work_order_bids (id) on delete set null;

create index if not exists vendor_invoices_estimate_visit_bid_idx
  on public.vendor_invoices (estimate_visit_bid_id)
  where estimate_visit_bid_id is not null;

-- Backfill the invoices already filed by that flow, and ONLY those: the same conditions
-- `isGenuineVisitFeeInvoice` checked before this column existed (same service, same
-- vendor, same manager, the visit marked done, and the total equal to the fee stored on
-- that bid). A row numbered `VISIT-…` that fails them was never payable as a visit fee
-- and stays unmarked, so it keeps being treated as an ordinary bill.
update public.vendor_invoices i
   set estimate_visit_bid_id = b.id
  from public.work_order_bids b
 where i.estimate_visit_bid_id is null
   and i.invoice_number like 'VISIT-%'
   and b.id::text = substring(i.invoice_number from 7)
   and b.work_order_id = i.work_order_id
   and b.vendor_user_id = i.vendor_user_id
   and b.manager_user_id = i.manager_user_id
   and b.estimate_visit_done_at is not null
   and b.estimate_visit_fee_cents > 0
   and b.estimate_visit_fee_cents = i.total_cents;
