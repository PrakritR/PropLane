-- Zillow Rental Network (Zillow · Trulia · HotPads) syndication feed.
--
-- One feed per manager account, registered once with Zillow. The feed key is
-- an opaque token, never the manager's user id, so the public feed URL leaks
-- no identity on its own. Same shape as `manager_house_public_links`
-- (20260914030000): service-role only, no client-role grants at all — the
-- public GET route (`/api/feeds/zillow/[feedKey]`) resolves it with the
-- service-role client, and the manager-facing "Zillow feed URL" settings row
-- reads/creates it through an authenticated route pinned to `auth.uid()`.
--
-- Per-listing opt-in state (`syndication.zillow`) is NOT a new column here —
-- it lives inside `manager_property_records.property_data.listingSubmission`,
-- the same JSONB blob every other listing field already round-trips through
-- on the existing wizard save path. No parallel column to keep in sync.

create table if not exists public.manager_syndication_feeds (
  id uuid primary key default gen_random_uuid(),
  manager_user_id uuid not null references auth.users (id) on delete cascade,
  feed_key text not null default gen_random_uuid()::text,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create unique index if not exists manager_syndication_feeds_manager_idx
  on public.manager_syndication_feeds (manager_user_id);

create unique index if not exists manager_syndication_feeds_feed_key_idx
  on public.manager_syndication_feeds (feed_key);

alter table public.manager_syndication_feeds enable row level security;

revoke all on table public.manager_syndication_feeds from anon, authenticated;
