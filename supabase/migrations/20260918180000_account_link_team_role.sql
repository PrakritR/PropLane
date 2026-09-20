-- Team role is a stamp + label on the invite. Authorization still reads the
-- permission map. Null on existing rows reads as Co-manager / Custom.

alter table public.account_link_invites
  add column if not exists team_role text;

alter table public.account_link_invites
  drop constraint if exists account_link_invites_team_role_check;

alter table public.account_link_invites
  add constraint account_link_invites_team_role_check
  check (
    team_role is null
    or team_role in (
      'viewer',
      'leasing',
      'property_manager',
      'bookkeeper',
      'maintenance',
      'full',
      'custom'
    )
  );

comment on column public.account_link_invites.team_role is
  'Product role stamp/label. Authorization reads property_co_manager_permissions, never this column.';

alter table public.manager_invite_links
  add column if not exists team_role text;

alter table public.manager_invite_links
  drop constraint if exists manager_invite_links_team_role_check;

alter table public.manager_invite_links
  add constraint manager_invite_links_team_role_check
  check (
    team_role is null
    or team_role in (
      'viewer',
      'leasing',
      'property_manager',
      'bookkeeper',
      'maintenance',
      'full',
      'custom'
    )
  );

comment on column public.manager_invite_links.team_role is
  'Copied onto account_link_invites.team_role when a manager link is redeemed.';
