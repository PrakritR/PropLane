-- Residency-scoped move-in/move-out evidence. All access goes through authenticated,
-- permission-scoped server operations; there is no direct client PostgREST access.
create table if not exists public.resident_inspections (
  id uuid primary key default gen_random_uuid(),
  application_id text not null,
  manager_user_id uuid not null references auth.users(id),
  property_id text not null,
  resident_email text not null,
  resident_user_id uuid references auth.users(id),
  resident_name text not null,
  property_label text not null,
  room_label text not null default '',
  kind text not null check (kind in ('move-in','move-out')),
  status text not null default 'draft' check (status in ('draft','submitted','completed')),
  inspection_date date not null,
  baseline_id uuid references public.resident_inspections(id),
  revision integer not null default 1 check (revision > 0),
  document jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists resident_inspections_owner_idx on public.resident_inspections(manager_user_id, updated_at desc);
create index if not exists resident_inspections_resident_idx on public.resident_inspections(resident_email, application_id);
create index if not exists resident_inspections_property_idx on public.resident_inspections(property_id);
create unique index if not exists resident_inspections_open_idx on public.resident_inspections(application_id, kind) where status <> 'completed';
alter table public.resident_inspections enable row level security;
revoke all on public.resident_inspections from anon, authenticated;
grant all on public.resident_inspections to service_role;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('inspection-evidence','inspection-evidence',false,5242880,array['image/jpeg','image/png','image/webp'])
on conflict(id) do nothing;
