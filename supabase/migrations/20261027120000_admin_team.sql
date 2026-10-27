-- Admin team (plan admin-team-1027, A5/A6): invite people to PropLane admin as Overall admin or as a workspace role.
--
-- 1. manager_invite_links.kind admits 'admin': a one-use, email-bound, 7-day link whose redemption grants the admin
--    role (or workspace seats). The grant it will make is stored on the row (admin_grant) by the inviter, never read
--    from the redeemer's request; redeeming re-checks the inviter still holds the authority to make it.
-- 2. admin_team_grants: the append-style record of who granted which Overall-admin / workspace-admin role and when,
--    for the Admin team list and the audit trail. SERVER-ONLY: RLS on, no policy, no grant to anon or authenticated
--    (the PostgREST surface is public, and this table is a trust signal for admin access).
--
-- Additive and idempotent. Nothing changes on existing rows.

alter table public.manager_invite_links
  drop constraint if exists manager_invite_links_kind_check,
  add constraint manager_invite_links_kind_check check (kind in ('manager', 'vendor', 'resident', 'admin'));

alter table public.manager_invite_links
  add column if not exists admin_grant jsonb;

comment on column public.manager_invite_links.admin_grant is
  'kind = admin only: the grant the link makes on redemption ({ role, workspaceIds, access }), written by the inviter. NULL on every other kind.';

create table if not exists public.admin_team_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  granted_by uuid,
  role text not null,
  workspace_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid
);

create index if not exists admin_team_grants_user_idx
  on public.admin_team_grants (user_id, created_at desc);

alter table public.admin_team_grants enable row level security;

revoke all on table public.admin_team_grants from anon, authenticated;

comment on table public.admin_team_grants is
  'Who granted which admin-team role (overall_admin or a workspace team role) to whom, when, and when it was revoked. Service-role routes only.';
