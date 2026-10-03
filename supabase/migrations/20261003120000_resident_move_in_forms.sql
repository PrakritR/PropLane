-- Move-in forms: one row per (residency, form) sent to a resident. Definitions live on the
-- property (listingSubmission.moveInFormTemplates); this table holds the INSTANCES, each with
-- an immutable snapshot of the questions the resident saw. All access goes through
-- authenticated, permission-scoped server routes (service role); there is no client
-- PostgREST access, so RLS is on with no policies and the client roles hold no privileges.
create table if not exists public.resident_move_in_forms (
  id uuid primary key default gen_random_uuid(),
  application_id text not null,
  manager_user_id uuid not null references auth.users(id),
  property_id text not null,
  property_label text not null default '',
  room_label text not null default '',
  resident_name text not null,
  resident_email text not null,
  resident_user_id uuid references auth.users(id),
  form_id text not null,
  form_name text not null,
  source text not null default 'built' check (source in ('built','upload')),
  snapshot jsonb not null,
  status text not null default 'sent' check (status in ('sent','submitted','cancelled')),
  answers jsonb not null default '[]'::jsonb,
  signed_document_sha256 text,
  sent_at timestamptz not null default now(),
  due_at timestamptz,
  submitted_at timestamptz,
  reminded_at timestamptz,
  manager_viewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists resident_move_in_forms_owner_idx on public.resident_move_in_forms(manager_user_id, updated_at desc);
create index if not exists resident_move_in_forms_resident_idx on public.resident_move_in_forms(resident_email, application_id);
create index if not exists resident_move_in_forms_property_idx on public.resident_move_in_forms(property_id);
-- One live copy of a form per residency: dispatch is idempotent. A cancelled copy frees the
-- slot so the manager can send the form again.
create unique index if not exists resident_move_in_forms_open_idx
  on public.resident_move_in_forms(application_id, form_id) where status <> 'cancelled';
alter table public.resident_move_in_forms enable row level security;
revoke all on public.resident_move_in_forms from anon, authenticated;
grant all on public.resident_move_in_forms to service_role;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('move-in-form-files', 'move-in-form-files', false, 10485760,
  array['image/png','image/jpeg','image/webp','image/heic'])
on conflict(id) do nothing;
