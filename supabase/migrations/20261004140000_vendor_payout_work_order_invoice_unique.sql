-- A service can carry TWO vendor invoices: the job's own bill and the
-- estimate-visit fee (`VISIT-<bid id>`, one per bid). Both are filed against
-- the same `work_order_id`, so `vendor_payouts_work_order_unique` — one row per
-- non-null work order — let a paid $50 visit fee consume the service's only
-- payout slot and the job's own invoice could then never be claimed
-- (`claim_vendor_invoice_payment` raised 23505).
--
-- Additive and idempotent. The replacement is strictly LOOSER than the index it
-- drops, so every existing row still satisfies it:
--   * one payout per (work order, invoice) for the invoice rail, and
--   * still exactly one non-invoice payout per work order for the older
--     approve-and-pay rail (invoice_id null collapses to one sentinel key,
--     because a plain multi-column unique index treats nulls as distinct).
-- Cross-rail double pay is arbitrated by `findBlockingVendorPayout`, which
-- refuses on any payout that moved money for the job.
drop index if exists public.vendor_payouts_work_order_unique;
create unique index if not exists vendor_payouts_work_order_invoice_unique
  on public.vendor_payouts (work_order_id, coalesce(invoice_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where work_order_id is not null;
