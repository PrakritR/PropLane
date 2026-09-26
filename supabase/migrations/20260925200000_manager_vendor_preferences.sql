-- N006: an ordered preferred-vendor list per (property, trade). A manager can
-- rank several vendors for the same property + trade combination; the
-- work-order auto-match suggestion (src/lib/work-order-auto-match.ts,
-- suggestVendorsForWorkOrder) tries this list FIRST, in priority order,
-- before falling back to its existing least-recently-assigned fairness
-- ranking. `property_id` is stored as plain text with no foreign key,
-- matching every other property-id column in this schema
-- (portal_work_order_records.property_id, manager_application_records.property_id)
-- — property records are not uniformly backed by one DB table.
--
-- No client writes: all inserts/updates/deletes go through a service-role
-- manager API route that re-derives ownership of both the property and the
-- vendor from the database, never from the request body (mirrors
-- manager_vendor_records / work_order_bids's manager-side read-only RLS).
create table if not exists public.manager_vendor_preferences (
  id uuid primary key default gen_random_uuid(),
  manager_user_id uuid not null references auth.users (id) on delete cascade,
  property_id text not null,
  trade text not null,
  vendor_id text not null references public.manager_vendor_records (id) on delete cascade,
  priority integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (manager_user_id, property_id, trade, vendor_id)
);

create index if not exists manager_vendor_preferences_lookup_idx
  on public.manager_vendor_preferences (manager_user_id, property_id, trade, priority);

alter table public.manager_vendor_preferences enable row level security;

drop policy if exists manager_vendor_preferences_owner_read on public.manager_vendor_preferences;
create policy manager_vendor_preferences_owner_read on public.manager_vendor_preferences
  for select using (manager_user_id = auth.uid());
