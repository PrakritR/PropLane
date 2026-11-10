-- Versions are snapshots; publishing a change inserts a new version.
create table if not exists public.resident_evidence_policies (
  id uuid primary key default gen_random_uuid(),
  property_id text not null references public.manager_property_records(id) on delete cascade,
  manager_user_id uuid not null references auth.users(id) on delete cascade,
  version integer not null check (version > 0),
  application_requirement text not null default 'none' check (application_requirement in ('none','id','background','both')),
  tour_requirement text not null default 'none' check (tour_requirement in ('none','id','background','both')),
  short_stay_requirement text not null default 'none' check (short_stay_requirement in ('none','id','background','both')),
  jurisdiction_state text not null,
  jurisdiction_city text not null,
  legal_review_reference text not null check (length(trim(legal_review_reference)) > 0),
  legal_approved boolean not null default false,
  identity_max_age_days integer check (identity_max_age_days > 0),
  screening_products text[] not null default '{}',
  tour_background_purpose_approved boolean not null default false,
  created_at timestamptz not null default now(),
  unique (property_id, version)
);
create index if not exists resident_evidence_policies_owner_idx on public.resident_evidence_policies(manager_user_id);
alter table public.resident_evidence_policies enable row level security;
revoke all on public.resident_evidence_policies from public, anon, authenticated;
grant select on public.resident_evidence_policies to authenticated;
grant all on public.resident_evidence_policies to service_role;
drop policy if exists resident_evidence_policy_owner_read on public.resident_evidence_policies;
create policy resident_evidence_policy_owner_read on public.resident_evidence_policies for select to authenticated
  using (exists (select 1 from public.manager_property_records p where p.id = property_id and p.manager_user_id = auth.uid()));
-- Immutability keeps previously accepted policy ids and versions meaningful.
create or replace function public.prevent_resident_evidence_policy_update() returns trigger
language plpgsql set search_path = public as $$ begin raise exception 'evidence policy versions are immutable'; end $$;
drop trigger if exists resident_evidence_policy_immutable on public.resident_evidence_policies;
create trigger resident_evidence_policy_immutable before update on public.resident_evidence_policies
for each row execute function public.prevent_resident_evidence_policy_update();
