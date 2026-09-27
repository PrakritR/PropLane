-- W013: one Zillow Rental Network feed per WORKSPACE, not per manager account.
--
-- `manager_syndication_feeds` (20260920203000) keyed on `manager_user_id`
-- alone, so a manager with several workspaces (`portal_workspaces`) got one
-- feed mixing every workspace's listings. This adds `workspace_id` and moves
-- the uniqueness constraint to (manager_user_id, workspace_id): a manager may
-- now hold one feed per workspace they own.
--
-- Backfill: every EXISTING feed keeps its exact `feed_key` (a manager who
-- already registered that URL with Zillow must not need to re-register) and
-- is pinned to that manager's DEFAULT workspace via
-- `ensure_default_portal_workspace` (creates one if somehow missing, same
-- helper `20260911230000_portal_workspaces.sql` introduced) — so the existing
-- feed URL keeps working, now scoped to the default workspace's listings.
-- Additive and idempotent; safe to re-run.

alter table public.manager_syndication_feeds
  add column if not exists workspace_id uuid references public.portal_workspaces(id) on delete cascade;

update public.manager_syndication_feeds f
set workspace_id = public.ensure_default_portal_workspace(f.manager_user_id)
where f.workspace_id is null;

alter table public.manager_syndication_feeds
  alter column workspace_id set not null;

-- Replace the old per-manager uniqueness with per-(manager, workspace).
drop index if exists manager_syndication_feeds_manager_idx;

create unique index if not exists manager_syndication_feeds_manager_workspace_idx
  on public.manager_syndication_feeds (manager_user_id, workspace_id);

create index if not exists manager_syndication_feeds_workspace_idx
  on public.manager_syndication_feeds (workspace_id);

-- Same posture as the original migration: service-role only, no client-role
-- grants at all. Re-asserted here since this migration also touches the
-- table's shape (idempotent no-op if already revoked).
revoke all on public.manager_syndication_feeds from anon, authenticated;
