-- C152 follow-up: let a marketplace bid reference the open listing it was
-- placed against by its own opaque id, so the vendor-facing browse response
-- (`publicOpenListingProjection`) never has to hand back `work_order_id` for
-- the client to correlate "have I already bid on this listing" — the client
-- keys on `work_order_open_listings.id` alone, and the server resolves the
-- real work order id from that id at submit/withdraw time
-- (`resolveWorkOrderIdForOpenListing`, src/lib/work-order-open-listings.server.ts).
--
-- Nullable and `on delete set null`: an Invited-tab bid (offered/assigned
-- vendor, no marketplace listing involved) simply never sets this column.
alter table public.work_order_bids
  add column if not exists open_listing_id uuid references public.work_order_open_listings (id) on delete set null;

create index if not exists work_order_bids_open_listing_idx on public.work_order_bids (open_listing_id);
