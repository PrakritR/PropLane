-- Vendor portal C152 Open tab: a genuine cross-workspace job marketplace.
--
-- A manager may publish a service (maintenance work order) as an "open to
-- bids" listing. The listing row carries ONLY the fields safe to show any
-- vendor on any workspace — trade/category, city/area, a manager-authored
-- description, desired timeframe, and an optional budget range. It never
-- carries the street address, unit, resident name/phone/email, access
-- notes, or photos that live on the underlying portal_work_order_records
-- row — those stay invisible until a vendor's bid is accepted and the
-- existing vendor_user_id assignment path grants real access to that row
-- (see /api/portal-work-orders' vendor_user_id scoping).
--
-- Bidding itself reuses the existing work_order_bids table/routes
-- unchanged (docs/agents/vendor-portal.md Phase 2) — this table only
-- answers "which jobs are open, to any vendor" and lets resolveVendorWorkOrderAccess
-- (src/lib/work-order-bids.server.ts) admit a vendor who was never
-- specifically offered this work order.
create table if not exists public.work_order_open_listings (
  id uuid primary key default gen_random_uuid(),
  work_order_id text not null unique references public.portal_work_order_records (id) on delete cascade,
  manager_user_id uuid not null references auth.users (id) on delete cascade,
  trade text not null,
  area text not null,
  description text not null,
  timeframe text,
  budget_min_cents integer,
  budget_max_cents integer,
  status text not null default 'open' check (status in ('open', 'closed')),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint work_order_open_listings_budget_non_negative
    check (budget_min_cents is null or budget_min_cents >= 0),
  constraint work_order_open_listings_budget_max_non_negative
    check (budget_max_cents is null or budget_max_cents >= 0),
  constraint work_order_open_listings_budget_order
    check (budget_min_cents is null or budget_max_cents is null or budget_min_cents <= budget_max_cents)
);

create index if not exists work_order_open_listings_status_idx on public.work_order_open_listings (status);
create index if not exists work_order_open_listings_trade_idx on public.work_order_open_listings (trade);
create index if not exists work_order_open_listings_manager_idx on public.work_order_open_listings (manager_user_id);

alter table public.work_order_open_listings enable row level security;

-- No client-side read policy at all, on either side. Both the manager's own
-- view (GET .../work-order-open-listings?workOrderId=) and the vendor's
-- cross-workspace browse are served EXCLUSIVELY by the service-role API
-- (src/app/api/portal/work-order-open-listings/route.ts), which applies a
-- redacted projection before anything reaches the client (the browse
-- response carries only an opaque listing id, never work_order_id or
-- manager_user_id). RLS constrains which ROW a policy exposes, never which
-- COLUMN, so a `status = 'open'` policy "for vendors" would let ANY
-- authenticated user — a resident, another manager, anyone signed in —
-- read every open listing's raw row directly via PostgREST, including its
-- manager_user_id and work_order_id: there is no policy shape here that is
-- "safe for vendors, safe for everyone else" without the API's projection in
-- front of it. So: no policy, and no privilege to even attempt one.
revoke all on public.work_order_open_listings from anon;
revoke all on public.work_order_open_listings from authenticated;
