-- Vendor Settings > Integrations (Oct 6): the private iCal "Calendar link" and the
-- "Request access" rows for providers that are not built yet.
--
-- Additive and idempotent: two new tables, indexes, and an RLS lock. Nothing existing is altered.
-- Both tables are service-role only: every read and write goes through a Next.js route that
-- re-derives the vendor from the session (or, for the public feed, from the signed token).
--
-- The feed token itself is never stored. It is an HMAC of (vendor id, version); `version` is all
-- that lives here, and bumping it ("Reset link") makes every earlier URL stop working.

create table if not exists public.vendor_calendar_feeds (
  vendor_user_id uuid primary key references auth.users (id) on delete cascade,
  version integer not null default 1,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.vendor_calendar_feeds enable row level security;

revoke all on table public.vendor_calendar_feeds from anon, authenticated;
grant all on table public.vendor_calendar_feeds to service_role;

create table if not exists public.vendor_integration_access_requests (
  id uuid primary key default gen_random_uuid(),
  vendor_user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('jobber', 'housecall_pro', 'thumbtack')),
  created_at timestamptz not null default now(),
  unique (vendor_user_id, provider)
);

create index if not exists vendor_integration_access_requests_vendor_idx
  on public.vendor_integration_access_requests (vendor_user_id);

alter table public.vendor_integration_access_requests enable row level security;

revoke all on table public.vendor_integration_access_requests from anon, authenticated;
grant all on table public.vendor_integration_access_requests to service_role;

-- Rollback:
--   drop table if exists public.vendor_integration_access_requests;
--   drop table if exists public.vendor_calendar_feeds;
