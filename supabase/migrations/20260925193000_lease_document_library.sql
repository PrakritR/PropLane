-- Workspace lease document library (PLAN night/custom-lease).
--
-- A manager who signs multiple leases against the same custom PDF used to have
-- to re-upload it every time (property submission, per-resident lease row).
-- This table is a small, workspace-scoped catalog of previously uploaded lease
-- PDFs so a property or a lease can pick one instead. It stores METADATA only
-- (name, the object's path in the existing private `lease-templates` bucket,
-- a default flag, and optional signature-field placements); the PDF bytes stay
-- exactly where `lease-template-storage.ts` already puts them, streamed only
-- through the existing re-authorizing route (`/api/portal/lease-template`).
--
-- Idempotent and additive; safe to re-run.

create table if not exists public.lease_document_library (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.portal_workspaces(id) on delete cascade,
  -- The uploader: also the storage folder owner (`lease-template-storage.ts`'s
  -- `<manager user id>/<unique>.pdf` convention), so the object's bytes stay
  -- readable by the existing route's folder-ownership branch even before any
  -- property or lease references the path.
  manager_user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  storage_path text not null unique,
  file_name text not null,
  is_default boolean not null default false,
  -- Signature field placements: [{ id, page, x, y, w, h, role, kind }], every
  -- coordinate normalized 0..1 against the page's own width/height so the same
  -- placement renders correctly regardless of viewer zoom or device pixel
  -- ratio. Empty array = no fields placed = today's behavior (certificate page
  -- only). Copied onto a lease row's `managerUploadedPdf.fields` when a
  -- manager attaches this entry to a resident's lease.
  fields jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One default per workspace, same shape as `portal_workspaces_default_owner`.
create unique index if not exists lease_document_library_default_per_workspace
  on public.lease_document_library (workspace_id) where is_default;

create index if not exists lease_document_library_workspace_idx
  on public.lease_document_library (workspace_id);

alter table public.lease_document_library enable row level security;
revoke all on public.lease_document_library from anon, authenticated;
grant select on public.lease_document_library to authenticated;
grant all on public.lease_document_library to service_role;

-- Defense-in-depth, matching `manager_documents`/`workspace_work_numbers`: the
-- real authorization (including co-manager "leases" access) is the service-role
-- API route (`/api/portal/lease-library`), which re-derives the caller's
-- workspace access via `assertSettingsScopeOwned`. This RLS policy only covers
-- the workspace OWNER reading their own rows directly.
drop policy if exists lease_document_library_owner_read on public.lease_document_library;
create policy lease_document_library_owner_read on public.lease_document_library
  for select to authenticated using (
    exists (
      select 1 from public.portal_workspaces w
      where w.id = workspace_id and w.owner_user_id = auth.uid()
    )
  );

-- Purge manifest: classified in `src/lib/auth/account-purge-manifest.ts`
-- (ACCOUNT_PURGE_RETAINED — cascades away with portal_workspaces, same as
-- workspace_work_numbers).
