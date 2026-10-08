-- Outgoing payments (vendor-portal-ia-1007): what a vendor spends to do the work.
--
-- Private to the vendor: managers never read these rows. One row per expense; a receipt, when
-- there is one, is a file in the private `vendor-documents` bucket under the vendor's own prefix
-- (read only through a server-minted signed URL), referenced here by `receipt_path`.
--
-- Additive and idempotent. RLS is on with a SELECT-own policy only, and clients are granted
-- SELECT only: every insert, update and delete goes through /api/vendor/expenses with the
-- service-role client pinned to the signed-in user's id (a body `vendor_user_id` is ignored).
create table if not exists public.vendor_expense_entries (
  id uuid primary key default gen_random_uuid(),
  vendor_user_id uuid not null references auth.users (id) on delete cascade,
  expense_date date not null,
  amount_cents integer not null check (amount_cents > 0),
  category text not null,
  memo text,
  -- The vendor's own service (portal_work_order_records.id, text) this expense belongs to; the
  -- route verifies it is assigned to this vendor before storing it.
  work_order_id text,
  receipt_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.vendor_expense_entries drop constraint if exists vendor_expense_entries_category_check;
alter table public.vendor_expense_entries add constraint vendor_expense_entries_category_check
  check (category in ('materials', 'tools', 'subcontractor', 'fuel_travel', 'permits_fees', 'other'));

create index if not exists vendor_expense_entries_vendor_date_idx
  on public.vendor_expense_entries (vendor_user_id, expense_date desc);

alter table public.vendor_expense_entries enable row level security;

drop policy if exists vendor_expense_entries_select_own on public.vendor_expense_entries;
create policy vendor_expense_entries_select_own on public.vendor_expense_entries
  for select to authenticated using (vendor_user_id = auth.uid());

revoke all on table public.vendor_expense_entries from anon, authenticated;
grant select on table public.vendor_expense_entries to authenticated;
