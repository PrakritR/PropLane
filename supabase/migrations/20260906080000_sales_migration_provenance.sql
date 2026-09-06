-- Import receipts are not canonical business records. They pin source identity and
-- retain reconciliation status while the real tables remain the portal's source.
create table public.sales_migration_records (
  id uuid primary key,
  manager_user_id uuid not null references auth.users(id),
  workbook_id text not null,
  property_id text not null,
  record_kind text not null,
  source_key text not null,
  source_sheet text not null,
  source_range text not null,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'prepared' check (status in ('prepared', 'completed')),
  canonical_id text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique(manager_user_id, workbook_id, property_id, record_kind, source_key)
);
alter table public.sales_migration_records enable row level security;
create policy sales_migration_owner_read on public.sales_migration_records
  for select to authenticated using (manager_user_id = auth.uid());
revoke all on public.sales_migration_records from anon, authenticated;
grant select on public.sales_migration_records to authenticated;
grant all on public.sales_migration_records to service_role;
create index sales_migration_owner_property on public.sales_migration_records(manager_user_id, property_id);
