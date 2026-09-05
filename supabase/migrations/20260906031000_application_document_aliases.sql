-- Keep original attachment references stable during encryption migration:
-- old browser autosaves still resolve to the encrypted object through this map.
create table if not exists public.application_document_storage_aliases (
  source_path text primary key,
  application_id text not null references public.manager_application_records(id) on delete cascade,
  encrypted_path text not null unique,
  created_at timestamptz not null default now(),
  source_removed_at timestamptz,
  check (source_path <> encrypted_path),
  check (source_path like 'application/%' and source_path not like '%.penc'),
  check (encrypted_path like 'application/%.penc')
);
create index if not exists application_document_alias_application_idx
  on public.application_document_storage_aliases(application_id);
alter table public.application_document_storage_aliases enable row level security;
revoke all on public.application_document_storage_aliases from public, anon, authenticated;
grant select, insert, update, delete on public.application_document_storage_aliases to service_role;
