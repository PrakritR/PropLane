-- Portfolio import (spreadsheet / AppFolio / Buildium export / rent-roll PDF).
--
-- `manager_portfolio_imports` holds one upload → draft → commit lifecycle. The
-- draft JSON carries resident names, emails and phones, so it is PII: owner-scoped
-- RLS, client roles may only SELECT, and every write goes through the service
-- role from the portfolio-import routes. The draft is not a canonical business
-- record; the real tables (manager_property_records, manager_application_records,
-- portal_lease_pipeline_records, household charges, tasks) remain the source.
--
-- `manager_portfolio_import_records` are receipts, one per planned record, so a
-- commit that stops halfway (timeout, a resident email owned by another manager)
-- resumes only the prepared records and never creates a second copy. Same shape
-- as sales_migration_records.

create table if not exists public.manager_portfolio_imports (
  id uuid primary key default gen_random_uuid(),
  manager_user_id uuid not null references auth.users(id) on delete cascade,
  source_kind text not null check (source_kind in ('csv', 'xlsx', 'pdf')),
  preset text not null default 'generic' check (preset in ('appfolio', 'buildium', 'generic', 'pdf')),
  file_name text not null,
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'uploaded'
    check (status in ('uploaded', 'draft', 'committing', 'completed', 'failed', 'discarded')),
  draft jsonb,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  committed_at timestamptz
);

alter table public.manager_portfolio_imports enable row level security;

drop policy if exists manager_portfolio_imports_owner_read on public.manager_portfolio_imports;
create policy manager_portfolio_imports_owner_read on public.manager_portfolio_imports
  for select to authenticated using (manager_user_id = auth.uid());

revoke all on public.manager_portfolio_imports from anon, authenticated;
grant select on public.manager_portfolio_imports to authenticated;
grant all on public.manager_portfolio_imports to service_role;

create index if not exists manager_portfolio_imports_owner_created
  on public.manager_portfolio_imports(manager_user_id, created_at desc);

-- The same bytes uploaded twice resolve to the existing import (409 with its id)
-- unless that import was discarded.
create unique index if not exists manager_portfolio_imports_owner_file_active
  on public.manager_portfolio_imports(manager_user_id, file_sha256)
  where status <> 'discarded';

create table if not exists public.manager_portfolio_import_records (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.manager_portfolio_imports(id) on delete cascade,
  manager_user_id uuid not null references auth.users(id) on delete cascade,
  record_kind text not null check (record_kind in ('property', 'room', 'resident', 'balance', 'task')),
  source_key text not null,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'prepared' check (status in ('prepared', 'completed')),
  canonical_id text,
  error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (import_id, record_kind, source_key)
);

alter table public.manager_portfolio_import_records enable row level security;

drop policy if exists manager_portfolio_import_records_owner_read on public.manager_portfolio_import_records;
create policy manager_portfolio_import_records_owner_read on public.manager_portfolio_import_records
  for select to authenticated using (manager_user_id = auth.uid());

revoke all on public.manager_portfolio_import_records from anon, authenticated;
grant select on public.manager_portfolio_import_records to authenticated;
grant all on public.manager_portfolio_import_records to service_role;

create index if not exists manager_portfolio_import_records_import
  on public.manager_portfolio_import_records(import_id, record_kind, status);
