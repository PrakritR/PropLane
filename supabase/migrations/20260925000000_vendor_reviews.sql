-- Vendor reviews: a manager rates a vendor's completed service, and the vendor
-- may reply once. One review per completed service (unique on work_order_id).
--
-- `vendor_user_id` is the review's stable vendor identity — mirrors
-- vendor_invoices / vendor_payouts / work_order_bids, which all key a vendor by
-- their auth user id rather than by `manager_vendor_records.id` (a manager's
-- own directory row, scoped to that one manager and NOT stable across the
-- several managers a vendor may work for). A review can only be created for a
-- work order whose `vendor_user_id` is already populated (the vendor has
-- signed up and been assigned) — enforced server-side, not by this schema.
--
-- No client writes: every insert/update goes through a service-role API route
-- that re-derives eligibility (completed status, workspace ownership, one
-- review per service, the 14-day edit window, the vendor's one-reply rule)
-- from the database, never from the request body. RLS below is read-only.
create table if not exists public.vendor_reviews (
  id uuid primary key default gen_random_uuid(),
  manager_user_id uuid not null references auth.users (id) on delete cascade,
  reviewer_user_id uuid references auth.users (id) on delete set null,
  vendor_user_id uuid not null references auth.users (id) on delete cascade,
  work_order_id text not null references public.portal_work_order_records (id) on delete cascade,
  stars smallint not null check (stars between 1 and 5),
  body text not null default '' check (char_length(body) <= 2000),
  vendor_reply text check (vendor_reply is null or char_length(vendor_reply) <= 2000),
  vendor_replied_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (work_order_id)
);

create index if not exists vendor_reviews_vendor_user_id_idx on public.vendor_reviews (vendor_user_id);
create index if not exists vendor_reviews_manager_user_id_idx on public.vendor_reviews (manager_user_id);
create index if not exists vendor_reviews_reviewer_user_id_idx on public.vendor_reviews (reviewer_user_id);

alter table public.vendor_reviews enable row level security;

-- SELECT-only for both roles from the start (matches the hardened end-state of
-- vendor_invoices/work_order_bids — no FOR ALL policy ever shipped here).
drop policy if exists vendor_reviews_manager_read on public.vendor_reviews;
create policy vendor_reviews_manager_read on public.vendor_reviews
  for select using (manager_user_id = auth.uid());

drop policy if exists vendor_reviews_vendor_read on public.vendor_reviews;
create policy vendor_reviews_vendor_read on public.vendor_reviews
  for select using (vendor_user_id = auth.uid());
