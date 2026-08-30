-- Per-room external channel calendar links (Airbnb iCal import/export).
-- Import URLs are secrets; reads/writes go through service-role API routes.
create table if not exists public.external_calendar_connections (
  id uuid primary key default gen_random_uuid(),
  manager_user_id uuid not null references auth.users (id) on delete cascade,
  property_id text not null,
  room_id text not null,
  provider text not null default 'airbnb',
  label text,
  import_url text,
  export_token text not null,
  imported_ranges jsonb not null default '[]'::jsonb,
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint external_calendar_connections_provider_check
    check (provider in ('airbnb')),
  constraint external_calendar_connections_export_token_unique unique (export_token),
  constraint external_calendar_connections_property_room_provider_unique
    unique (property_id, room_id, provider)
);

create index if not exists external_calendar_connections_manager_idx
  on public.external_calendar_connections (manager_user_id);

create index if not exists external_calendar_connections_property_idx
  on public.external_calendar_connections (property_id);

alter table public.external_calendar_connections enable row level security;

drop policy if exists "external_calendar_connections_owner" on public.external_calendar_connections;
create policy "external_calendar_connections_owner"
  on public.external_calendar_connections
  for all
  using (auth.uid() = manager_user_id);
