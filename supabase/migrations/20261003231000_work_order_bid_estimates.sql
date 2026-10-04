-- Vendor bids: an ESTIMATE is not a BID.
--
-- An estimate is the vendor's rough price before seeing the job. It can never be
-- approved and never becomes a payment. A bid is the real price (labor +
-- materials + a time) and is the only thing a manager can approve. An estimate
-- visit may carry an optional visit fee the manager pays once the visit happened.
--
-- Additive and idempotent. No RLS or grant changes: vendors stay SELECT-only on
-- work_order_bids and every write goes through the service-role API.

alter table public.work_order_bids
  add column if not exists estimate_cents integer,
  add column if not exists estimate_given_at timestamptz,
  add column if not exists bid_submitted_at timestamptz,
  add column if not exists estimate_visit_fee_cents integer not null default 0,
  add column if not exists estimate_visit_done_at timestamptz;

alter table public.work_order_bids
  drop constraint if exists work_order_bids_estimate_cents_check;
alter table public.work_order_bids
  add constraint work_order_bids_estimate_cents_check
  check (estimate_cents is null or estimate_cents > 0);

alter table public.work_order_bids
  drop constraint if exists work_order_bids_estimate_visit_fee_cents_check;
alter table public.work_order_bids
  add constraint work_order_bids_estimate_visit_fee_cents_check
  check (estimate_visit_fee_cents >= 0);

-- A bid that already carried a price before this migration was a submitted bid.
update public.work_order_bids
   set bid_submitted_at = coalesce(updated_at, created_at)
 where amount_cents is not null
   and bid_submitted_at is null;

-- One estimate-visit fee invoice per bid (invoice_number = 'VISIT-' || bid id): the
-- "visit happened" action can be retried or raced and still bills the fee once.
create unique index if not exists vendor_invoices_visit_fee_unique
  on public.vendor_invoices (work_order_id, invoice_number)
  where invoice_number like 'VISIT-%';
