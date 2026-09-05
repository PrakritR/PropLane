-- Shareable invite links for co-managers and vendors.
--
-- The existing `account_link_invites` row is ADDRESSED: it names an
-- `invitee_user_id` up front, so the inviter needs the other person's PropLane
-- ID before they can invite them at all. An invite LINK is the other shape —
-- scope and permissions are decided first, then a link is minted that whoever
-- opens it redeems. Separate table because it is a different object: a bearer
-- credential with a use budget and an expiry, not a message to one account.
--
-- SECURITY. This row grants module access to real properties, so it is a trust
-- signal in exactly the sense AGENTS.md means:
--
--  * Only the SHA-256 of the token is stored. The raw token is returned once at
--    mint time and never again, the same contract as the resident setup token
--    and REST API keys. A database read cannot recover a working link.
--  * NO grants to `anon` or `authenticated`. PostgREST exposes the public
--    schema, so any privilege here is reachable from a browser console with the
--    shipped anon key; every read and write goes through a service-role route
--    that authorizes first. RLS is enabled with no policy, which denies the
--    client roles outright rather than relying on one being written correctly.
--  * `used_count` is advanced by a conditional UPDATE inside the redeem path,
--    so two people opening a one-time link at the same moment cannot both win.
--  * Redemptions are recorded per user with a unique constraint, so re-opening
--    a link you already redeemed is a no-op rather than a second use.
--
-- Idempotent throughout: `create table if not exists`, `add column if not
-- exists`, and policies/constraints dropped by name before being recreated.

create table if not exists public.manager_invite_links (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null default 'manager',
  token_hash text not null unique,
  label text,
  assigned_property_ids text[] not null default '{}',
  property_permissions jsonb not null default '{}'::jsonb,
  -- null = unlimited uses / never expires, matching the "No limit" and "Never"
  -- options in the UI. Both are deliberate choices a manager can make, so they
  -- are representable rather than approximated by a very large number.
  max_uses integer,
  used_count integer not null default 0,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.manager_invite_links
  drop constraint if exists manager_invite_links_kind_check,
  add constraint manager_invite_links_kind_check check (kind in ('manager', 'vendor')),
  drop constraint if exists manager_invite_links_max_uses_check,
  add constraint manager_invite_links_max_uses_check check (max_uses is null or max_uses > 0),
  drop constraint if exists manager_invite_links_used_count_check,
  add constraint manager_invite_links_used_count_check check (used_count >= 0);

create index if not exists manager_invite_links_owner_idx
  on public.manager_invite_links (owner_user_id, created_at desc);

create table if not exists public.manager_invite_link_redemptions (
  id uuid primary key default gen_random_uuid(),
  link_id uuid not null references public.manager_invite_links(id) on delete cascade,
  redeemed_by_user_id uuid not null references auth.users(id) on delete cascade,
  redeemed_at timestamptz not null default now()
);

-- Re-opening a link you already redeemed must not spend another use, and must
-- not create a second relationship.
create unique index if not exists manager_invite_link_redemptions_unique_idx
  on public.manager_invite_link_redemptions (link_id, redeemed_by_user_id);

alter table public.manager_invite_links enable row level security;
alter table public.manager_invite_link_redemptions enable row level security;

-- No policies, and no grants. Both tables are service-role only: a link is a
-- credential, and the owner reads their own through an authorizing route that
-- returns the metadata WITHOUT the token.
revoke all on public.manager_invite_links from anon, authenticated;
revoke all on public.manager_invite_link_redemptions from anon, authenticated;

comment on table public.manager_invite_links is
  'Shareable co-manager / vendor invite links. Bearer credentials: only the token SHA-256 is stored, and both this table and its redemptions are service-role only.';
comment on column public.manager_invite_links.token_hash is
  'SHA-256 hex of the raw link token. The raw token is shown once at mint time and is not recoverable from this row.';
comment on column public.manager_invite_links.assigned_property_ids is
  'Properties the link may grant on. Re-validated against the owner CURRENT ownership at redemption — this column is a bound, never the authorization itself.';
