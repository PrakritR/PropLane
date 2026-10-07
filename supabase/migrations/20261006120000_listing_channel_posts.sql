-- Listing sites: per-listing, per-channel posting state, and the workspace's Meta connection.
--
-- `listing_channel_posts` is both the record and the queue. One row per (property, channel):
-- whether the manager has the channel on for that listing, where it stands (`state`), the
-- channel's own post id (`external_id`) and the last failure. `pending_action` is the queued work
-- (publish / update / unpublish); the cron route and the property save path drain it with retries
-- (`attempts`, `next_attempt_at`). `content_hash` is the hash of the text + first photo last
-- posted, so a price change is noticed and becomes an update.
--
-- RLS: client roles may only SELECT their own rows (`manager_user_id = auth.uid()`). Every write is a
-- server route using the service role pinned to the authenticated manager; a property id in a request
-- body is never authorization (the route re-derives ownership from the stored record).
--
-- `listing_channel_connections` holds the long-lived Meta page token (AES-GCM, same
-- `data-encryption` envelope as the Google calendar tokens). Service-role only: no client policy,
-- no client grant, not even SELECT.
--
-- Additive and idempotent; safe to re-run.

create table if not exists public.listing_channel_posts (
  id uuid primary key default gen_random_uuid(),
  manager_user_id uuid not null references auth.users (id) on delete cascade,
  workspace_id uuid references public.portal_workspaces (id) on delete cascade,
  property_id text not null,
  channel text not null,
  enabled boolean not null default true,
  state text not null default 'pending',
  pending_action text,
  external_id text,
  last_error text,
  content_hash text,
  attempts integer not null default 0,
  next_attempt_at timestamptz,
  posted_at timestamptz,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint listing_channel_posts_state_check
    check (state in ('pending', 'posting', 'posted', 'held', 'failed', 'off', 'posted_by_me')),
  constraint listing_channel_posts_action_check
    check (pending_action is null or pending_action in ('publish', 'update', 'unpublish'))
);

create unique index if not exists listing_channel_posts_property_channel_idx
  on public.listing_channel_posts (property_id, channel);

create index if not exists listing_channel_posts_manager_idx
  on public.listing_channel_posts (manager_user_id, workspace_id);

create index if not exists listing_channel_posts_queue_idx
  on public.listing_channel_posts (next_attempt_at)
  where pending_action is not null;

alter table public.listing_channel_posts enable row level security;

revoke all on table public.listing_channel_posts from anon, authenticated;
grant select on table public.listing_channel_posts to authenticated;
grant all on table public.listing_channel_posts to service_role;

drop policy if exists listing_channel_posts_select_own on public.listing_channel_posts;
create policy listing_channel_posts_select_own
  on public.listing_channel_posts
  for select
  to authenticated
  using (manager_user_id = auth.uid());

create table if not exists public.listing_channel_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.portal_workspaces (id) on delete cascade,
  manager_user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null default 'meta',
  provider_subject text not null,
  page_id text,
  page_name text,
  ig_account_id text,
  ig_username text,
  page_token_encrypted text not null,
  project_ref text,
  revoked boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint listing_channel_connections_provider_check check (provider in ('meta'))
);

create unique index if not exists listing_channel_connections_workspace_provider_idx
  on public.listing_channel_connections (workspace_id, provider);

create index if not exists listing_channel_connections_provider_subject_idx
  on public.listing_channel_connections (provider, provider_subject);

alter table public.listing_channel_connections enable row level security;

revoke all on table public.listing_channel_connections from anon, authenticated;
grant all on table public.listing_channel_connections to service_role;
