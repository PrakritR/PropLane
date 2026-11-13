-- Resident identity verification stores only provider references and decisions.
-- Raw identity documents and provider payloads remain with Persona.
create table if not exists public.resident_identity_subjects (
  resident_user_id uuid primary key references auth.users(id) on delete cascade,
  status text not null default 'not_started' check (status in ('not_started', 'pending', 'review', 'approved', 'declined', 'expired')),
  provider_decision text check (provider_decision in ('approved', 'declined', 'review')),
  verified_at timestamptz,
  last_event_id text,
  last_event_created_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'approved' and provider_decision is not distinct from 'approved' and verified_at is not null) or (status <> 'approved' and verified_at is null))
);

-- The claim is created before a provider request; an uncertain outcome remains
-- claimed until reconciled. Only one active inquiry is allowed per resident.
create table if not exists public.resident_identity_inquiries (
  id uuid primary key default gen_random_uuid(),
  resident_user_id uuid not null references public.resident_identity_subjects(resident_user_id) on delete cascade,
  provider text not null default 'persona' check (provider = 'persona'),
  provider_inquiry_id text unique,
  claim_key uuid not null unique default gen_random_uuid(),
  status text not null default 'claimed' check (status in ('claimed', 'pending', 'review', 'approved', 'declined', 'expired', 'reconciliation')),
  active boolean not null default true,
  last_event_id text,
  last_event_created_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists resident_identity_inquiry_owner_idx
  on public.resident_identity_inquiries (id, resident_user_id);
create unique index if not exists resident_identity_one_active_inquiry_idx
  on public.resident_identity_inquiries (resident_user_id) where active;

-- Event IDs deduplicate signed deliveries. No request body or identity data is stored.
create table if not exists public.resident_identity_webhook_events (
  event_id text primary key,
  resident_user_id uuid not null references public.resident_identity_subjects(resident_user_id) on delete cascade,
  inquiry_id uuid not null,
  event_type text not null,
  provider_created_at timestamptz not null,
  received_at timestamptz not null default now(),
  last_received_at timestamptz not null default now(),
  signed_delivery_count integer not null default 1 check (signed_delivery_count > 0),
  disposition text not null check (disposition in ('applied', 'stale', 'ignored')),
  foreign key (inquiry_id, resident_user_id) references public.resident_identity_inquiries(id, resident_user_id) on delete cascade
);

create table if not exists public.resident_identity_manual_reviews (
  id uuid primary key default gen_random_uuid(),
  resident_user_id uuid not null references public.resident_identity_subjects(resident_user_id) on delete cascade,
  status text not null default 'requested' check (status in ('requested', 'in_review', 'approved', 'declined', 'closed')),
  requested_at timestamptz not null default now(),
  resolved_at timestamptz,
  check ((status in ('approved', 'declined', 'closed')) = (resolved_at is not null))
);
create unique index if not exists resident_identity_one_open_review_idx
  on public.resident_identity_manual_reviews (resident_user_id) where status in ('requested', 'in_review');

alter table public.resident_identity_subjects enable row level security;
alter table public.resident_identity_inquiries enable row level security;
alter table public.resident_identity_webhook_events enable row level security;
alter table public.resident_identity_manual_reviews enable row level security;

revoke all on public.resident_identity_subjects, public.resident_identity_inquiries, public.resident_identity_webhook_events, public.resident_identity_manual_reviews from public, anon, authenticated;
grant select on public.resident_identity_subjects, public.resident_identity_inquiries, public.resident_identity_webhook_events, public.resident_identity_manual_reviews to authenticated;
grant all on public.resident_identity_subjects, public.resident_identity_inquiries, public.resident_identity_webhook_events, public.resident_identity_manual_reviews to service_role;

drop policy if exists resident_identity_subject_owner_read on public.resident_identity_subjects;
create policy resident_identity_subject_owner_read on public.resident_identity_subjects for select to authenticated using (resident_user_id = auth.uid());
drop policy if exists resident_identity_inquiry_owner_read on public.resident_identity_inquiries;
create policy resident_identity_inquiry_owner_read on public.resident_identity_inquiries for select to authenticated using (resident_user_id = auth.uid());
drop policy if exists resident_identity_event_owner_read on public.resident_identity_webhook_events;
create policy resident_identity_event_owner_read on public.resident_identity_webhook_events for select to authenticated using (resident_user_id = auth.uid());
drop policy if exists resident_identity_review_owner_read on public.resident_identity_manual_reviews;
create policy resident_identity_review_owner_read on public.resident_identity_manual_reviews for select to authenticated using (resident_user_id = auth.uid());
