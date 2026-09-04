-- PRP-254 #2: a vendor who is booked, or does not cover that trade, had no way to say no.
-- The status column allowed only 'sent' and 'withdrawn', and 'withdrawn' is a MANAGER action
-- (they pull the offer back). So an offer the vendor did not want sat in their list
-- indefinitely while the manager waited for a reply the product gave no way to send —
-- and could not tell "not interested" from "hasn't looked yet".
--
-- 'declined' is the vendor's own answer, with an optional reason so the manager learns
-- something more useful than a status flip.
--
-- Idempotent per the repo rule: Supabase records migrations under apply-time versions and
-- replays them with `db push --include-all`, so re-running this must be a no-op.

alter table public.work_order_vendor_offers
  drop constraint if exists work_order_vendor_offers_status_check;

alter table public.work_order_vendor_offers
  add constraint work_order_vendor_offers_status_check
  check (status in ('sent', 'withdrawn', 'declined'));

alter table public.work_order_vendor_offers
  add column if not exists declined_reason text;

alter table public.work_order_vendor_offers
  add column if not exists declined_at timestamptz;

-- Still read-only for both sides at the database layer: the decline goes through the
-- service-role route, which is where the vendor's ownership of the offer is re-derived.
-- Granting the vendor an UPDATE here would let a public client set any status on any row
-- the read policy exposes, including flipping a manager's 'withdrawn' back to 'sent'.
