-- A Custom-role invite link's workspace-level grant (members/billing rights),
-- so the copied/sent link actually carries what the manager set on screen
-- instead of the redeem path silently defaulting it away. Mirrors
-- account_link_invites.workspace_permissions (20260918153000_workspace_permissions.sql).

alter table public.manager_invite_links
  add column if not exists workspace_permissions jsonb not null default '{}'::jsonb;

comment on column public.manager_invite_links.workspace_permissions is
  'Workspace grants: { addProperties, teams }. Empty for every role but Custom. Set at mint time from the invite sheet''s access chip.';
