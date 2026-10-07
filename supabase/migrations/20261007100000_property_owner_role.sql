-- Property owner: a read-only team role for the investor who owns a house the
-- manager runs. Idempotent. Not applied by this file's author.

-- 1. The role joins the catalogue on both invite tables.
alter table public.account_link_invites
  drop constraint if exists account_link_invites_team_role_check;
alter table public.account_link_invites
  add constraint account_link_invites_team_role_check
  check (
    team_role is null
    or team_role in ('property_owner', 'viewer', 'leasing', 'property_manager', 'bookkeeper', 'maintenance', 'admin', 'full', 'custom')
  );

alter table public.manager_invite_links
  drop constraint if exists manager_invite_links_team_role_check;
alter table public.manager_invite_links
  add constraint manager_invite_links_team_role_check
  check (
    team_role is null
    or team_role in ('property_owner', 'viewer', 'leasing', 'property_manager', 'bookkeeper', 'maintenance', 'admin', 'full', 'custom')
  );

-- 2. The manager decides which library files a Property owner may open.
--    Default false: nothing is visible to an owner until it is shared.
alter table public.manager_documents
  add column if not exists shared_with_owners boolean not null default false;

create index if not exists manager_documents_shared_with_owners_idx
  on public.manager_documents (property_id)
  where shared_with_owners and deleted_at is null;
