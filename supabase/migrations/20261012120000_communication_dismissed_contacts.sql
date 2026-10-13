-- Communication: a deleted empty chat stays deleted.
--
-- An approved resident with no conversation yet is listed in Communication as a
-- "No messages yet" row built from the resident directory. Deleting it used to
-- do nothing durable (the row was rebuilt on the next load). A dismissal is the
-- viewer's own, per workspace: the row is not built again until a real message
-- exists with that person (a live conversation always wins over a dismissal).
--
-- Additive. RLS on; a viewer may SELECT only their own rows; every write goes
-- through POST /api/portal-inbox-threads (service role, viewer and workspace
-- resolved on the server), so no INSERT/UPDATE/DELETE grant or policy exists.

create table if not exists public.communication_dismissed_contacts (
  id uuid primary key default gen_random_uuid(),
  viewer_user_id uuid not null,
  workspace_id uuid not null references public.portal_workspaces(id) on delete cascade,
  -- The person's lower-cased email (the directory's own contact key).
  contact_key text not null,
  dismissed_at timestamptz not null default now(),
  unique (viewer_user_id, workspace_id, contact_key)
);

create index if not exists communication_dismissed_contacts_viewer_workspace_idx
  on public.communication_dismissed_contacts (viewer_user_id, workspace_id);

alter table public.communication_dismissed_contacts enable row level security;

revoke all on public.communication_dismissed_contacts from anon, authenticated;
grant select on public.communication_dismissed_contacts to authenticated;

drop policy if exists communication_dismissed_contacts_select_own on public.communication_dismissed_contacts;
create policy communication_dismissed_contacts_select_own
  on public.communication_dismissed_contacts
  for select
  to authenticated
  using (viewer_user_id = auth.uid());
