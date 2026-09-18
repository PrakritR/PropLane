-- Workspace-level co-manager grants (Add properties, Invite teammates) and
-- which workspace a link belongs to when it still has no houses.

alter table public.account_link_invites
  add column if not exists workspace_id uuid references public.portal_workspaces(id) on delete set null;

alter table public.account_link_invites
  add column if not exists workspace_permissions jsonb not null default '{}'::jsonb;

create index if not exists account_link_invites_workspace_idx
  on public.account_link_invites(workspace_id);

comment on column public.account_link_invites.workspace_id is
  'Workspace this invite sits under when houses are empty. Null = default workspace of the owner.';

comment on column public.account_link_invites.workspace_permissions is
  'Workspace grants: { addProperties, teams }. Empty object is no workspace access.';

-- Existing teammates were invited to help in that workspace. Stamp Add properties
-- so a zero-house incoming Team can create listings without a second edit pass.
update public.account_link_invites
set workspace_permissions = coalesce(workspace_permissions, '{}'::jsonb) || '{"addProperties": true}'::jsonb
where status in ('pending', 'accepted');
