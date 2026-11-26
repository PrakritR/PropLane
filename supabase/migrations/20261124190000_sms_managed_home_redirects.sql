-- One row per (phone, PropLane-managed workspace) told once, on the PropLane line, to text the workspace's own number.
-- The redirect is not repeated for 30 days; later texts are still logged to the workspace thread and get a short answer.
-- Additive and idempotent; service-role only.
create table if not exists public.sms_managed_home_redirects (
  phone_key text not null,
  workspace_id uuid not null references public.portal_workspaces (id) on delete cascade,
  notified_at timestamptz not null default now(),
  message_sid text,
  created_at timestamptz not null default now(),
  primary key (phone_key, workspace_id)
);

alter table public.sms_managed_home_redirects enable row level security;
revoke all on public.sms_managed_home_redirects from anon, authenticated;
grant all on public.sms_managed_home_redirects to service_role;
