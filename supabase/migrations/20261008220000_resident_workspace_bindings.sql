-- Proof that a resident's own signed-in session bound their account to a manager.
--
-- Deleting a resident from a manager's portfolio may also delete the resident's
-- PropLane login, but only when the ACCOUNT'S OWNER established the relationship
-- themselves. An application row proves nothing: its email is chosen by the
-- manager (manual add, import, sheet sync). This row is written by exactly one
-- code path - the resident's own authenticated application submit
-- (POST /api/manager-applications, resident self-write branch) - with the user
-- id taken from the session, never from the request. No manager-writable route
-- inserts here. Client roles get no access at all.
--
-- Additive only. Residents who applied before this table existed have no row, so
-- deleting them from a portfolio keeps their login (fails safe).
create table if not exists public.resident_workspace_bindings (
  resident_user_id uuid not null references auth.users (id) on delete cascade,
  manager_user_id uuid not null references auth.users (id) on delete cascade,
  application_id text,
  created_at timestamptz not null default now(),
  primary key (resident_user_id, manager_user_id)
);

create index if not exists resident_workspace_bindings_manager_idx
  on public.resident_workspace_bindings (manager_user_id);

alter table public.resident_workspace_bindings enable row level security;
revoke all on public.resident_workspace_bindings from anon, authenticated;
grant all on public.resident_workspace_bindings to service_role;
