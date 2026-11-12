-- Resident ratings: a manager who has housed someone rates them 1-5 stars with an optional written review, and a
-- future manager reviewing that person's application sees the average, the count and the reviews (never the rater
-- or the other workspace's name or address). The resident may add one public response per rating and may dispute it.
-- Additive and idempotent. Service-role only: RLS is on with no policy and every client privilege is revoked, so the
-- public PostgREST surface reads and writes nothing here (a rating is never a client-writable or client-readable row).

create table if not exists public.resident_ratings (
  id uuid primary key default gen_random_uuid(),
  resident_user_id uuid not null references auth.users (id) on delete cascade,
  -- Who rated. Nulled when that manager's login is deleted: the rating stays, shown as "A previous manager".
  rater_user_id uuid references auth.users (id) on delete set null,
  workspace_id uuid references public.portal_workspaces (id) on delete set null,
  -- The stay the rating is about: the resident's application record id (the lease / stay hangs off it).
  residency_ref text not null,
  -- The house's city when it was rated: the only place fact a future manager sees (never the name or address).
  house_city text,
  stars smallint not null check (stars between 1 and 5),
  review text not null default '' check (char_length(review) <= 1000),
  resident_response text check (resident_response is null or char_length(resident_response) <= 500),
  response_at timestamptz,
  -- A resident's dispute (routed to PropLane support) shows "Disputed by resident" to future managers until resolved.
  disputed_at timestamptz,
  dispute_resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.resident_ratings add column if not exists house_city text;

-- One rating per residency per workspace.
create unique index if not exists resident_ratings_residency_workspace_idx
  on public.resident_ratings (residency_ref, workspace_id);

create index if not exists resident_ratings_resident_idx
  on public.resident_ratings (resident_user_id, created_at desc);

create index if not exists resident_ratings_rater_idx
  on public.resident_ratings (rater_user_id);

alter table public.resident_ratings enable row level security;

revoke all on table public.resident_ratings from anon, authenticated;
revoke insert, update, delete on table public.resident_ratings from anon, authenticated;
revoke select, truncate, references, trigger on table public.resident_ratings from anon, authenticated;
