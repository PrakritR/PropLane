-- Service workspaces: one per owner client (one-number W15, addendum 3).
--   * portal_workspaces.owner_of_record_name - the client's name, optional, typed when the workspace is added
--     (before the client has an account on the team); the flagged member below wins once there is one;
--   * account_link_invites.is_owner_of_record - marks THE membership that is the property owner of record, for
--     payouts and finances (W17). At most one live (pending or accepted) row per workspace. It grants nothing by
--     itself: access still comes from the Admin role on the membership.
-- Additive and idempotent.

alter table public.portal_workspaces add column if not exists owner_of_record_name text;
alter table public.portal_workspaces drop constraint if exists portal_workspaces_owner_of_record_name_length;
alter table public.portal_workspaces add constraint portal_workspaces_owner_of_record_name_length
  check (owner_of_record_name is null or length(btrim(owner_of_record_name)) between 1 and 80);

alter table public.account_link_invites add column if not exists is_owner_of_record boolean not null default false;
create unique index if not exists account_link_invites_one_owner_of_record
  on public.account_link_invites (workspace_id)
  where is_owner_of_record and status in ('pending', 'accepted');
