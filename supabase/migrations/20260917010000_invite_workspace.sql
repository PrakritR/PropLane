-- Workspace-scoped invite links: copy the same URL without reminting.
--
-- Hash is still the redeem credential. Ciphertext is a recoverable copy for
-- the owner so Copy does not rotate. Rotate remains an explicit action.
-- Property labels and workspace name are snapshotted at mint because
-- `manager_property_records.row_data` is often empty on the server.

alter table public.manager_invite_links
  add column if not exists workspace_id uuid references public.portal_workspaces(id) on delete set null;

alter table public.manager_invite_links
  add column if not exists workspace_name_snapshot text;

alter table public.manager_invite_links
  add column if not exists property_labels jsonb not null default '[]'::jsonb;

alter table public.manager_invite_links
  add column if not exists token_ciphertext text;

create index if not exists manager_invite_links_workspace_idx
  on public.manager_invite_links(workspace_id);

comment on column public.manager_invite_links.token_ciphertext is
  'AES-GCM ciphertext of the bearer token for same-URL copy. Null on links minted before this column or when encryption was unavailable.';
