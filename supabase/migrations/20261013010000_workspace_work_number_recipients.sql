-- People who are not PropLane accounts but should get every manager notice the workspace's work
-- number sends (new Airbnb bookings, tours, payments): a text from the work number and an email
-- from the work email. Service-role routes only; no client policies by design. Idempotent.
create table if not exists public.workspace_work_number_recipients (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,
  label text not null,
  phone text null,
  email text null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  constraint workspace_work_number_recipients_contact check (phone is not null or email is not null)
);

create index if not exists workspace_work_number_recipients_owner_idx
  on public.workspace_work_number_recipients (owner_user_id, created_at);

alter table public.workspace_work_number_recipients enable row level security;
