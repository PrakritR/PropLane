-- Vendor services: the accounts a manager says they hold at outside marketplaces (TaskRabbit, Thumbtack, ...).
--
-- One row per (workspace, marketplace). PropLane never logs in to a marketplace and never stores a
-- password or token: `account_label` is the email or name the manager used there and `profile_url` an
-- optional https link to the profile. The row only lets the Vendor services tab say "Account added".
--
-- Same posture as `listing_channel_connections`: RLS on, NO client policy, no client grant. Every read and
-- write is a server route using the service role, pinned to the authenticated manager's active workspace.
--
-- Additive and idempotent; safe to re-run.

create table if not exists public.vendor_marketplace_accounts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.portal_workspaces (id) on delete cascade,
  manager_user_id uuid not null references auth.users (id) on delete cascade,
  marketplace text not null,
  account_label text not null,
  profile_url text,
  connected_at timestamptz not null default now(),
  constraint vendor_marketplace_accounts_label_check
    check (char_length(account_label) between 1 and 120),
  constraint vendor_marketplace_accounts_profile_url_check
    check (profile_url is null or (profile_url like 'https://%' and char_length(profile_url) <= 500))
);

create unique index if not exists vendor_marketplace_accounts_workspace_marketplace_idx
  on public.vendor_marketplace_accounts (workspace_id, marketplace);

create index if not exists vendor_marketplace_accounts_manager_idx
  on public.vendor_marketplace_accounts (manager_user_id);

alter table public.vendor_marketplace_accounts enable row level security;

revoke all on table public.vendor_marketplace_accounts from anon, authenticated;
grant all on table public.vendor_marketplace_accounts to service_role;
