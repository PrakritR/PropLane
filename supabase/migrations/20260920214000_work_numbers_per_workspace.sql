-- Work numbers per workspace, part 3: a workspace may hold up to TWO work
-- numbers, and one physical number may serve two workspaces (its threads show
-- in both, either workspace can send from it). `manager_sms_numbers` keeps its
-- existing "one row per (home) workspace" shape untouched — that invariant is
-- load-bearing for the money-guarded Twilio purchase state machine in
-- manager-number-provisioning.server.ts (idempotent upsert on workspace_id,
-- the workspace-scoped provisioning lock) and this migration does not touch it.
--
-- What is new is purely additive: `workspace_work_numbers` is the many-to-many
-- ASSIGNMENT layer between a workspace and a number. Every existing number's
-- home placement is backfilled here as its primary assignment, so nothing
-- reads differently until a manager explicitly assigns a number to a second
-- workspace. Security-sensitive routing (who a thread is visible to, which
-- number a workspace sends from) must read THIS table, never assume a number's
-- `manager_sms_numbers.workspace_id` column is the only place it lives.

create table if not exists public.workspace_work_numbers (
  workspace_id uuid not null references public.portal_workspaces(id) on delete cascade,
  number_id uuid not null references public.manager_sms_numbers(id) on delete cascade,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (workspace_id, number_id)
);

create index if not exists workspace_work_numbers_number_idx
  on public.workspace_work_numbers (number_id);

-- At most one PRIMARY assignment per workspace — the workspace's own line,
-- shown first and used as the outbound default.
create unique index if not exists workspace_work_numbers_primary_uniq
  on public.workspace_work_numbers (workspace_id) where is_primary;

-- Hard ceiling: two numbers per workspace, own or shared-in, matches the
-- product cap in docs/agents/comms-billing.md ("Extra work number ... up to 2
-- per workspace"). Enforced here, not only in the app layer, because this
-- table is the join-table source of truth every routing/visibility read uses.
create or replace function public.enforce_workspace_work_number_limit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if (select count(*) from public.workspace_work_numbers where workspace_id = new.workspace_id) >= 2 then
    raise exception 'A workspace can hold at most 2 work numbers.' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_workspace_work_number_limit() from public, anon, authenticated;
drop trigger if exists workspace_work_numbers_limit on public.workspace_work_numbers;
create trigger workspace_work_numbers_limit
  before insert on public.workspace_work_numbers
  for each row execute function public.enforce_workspace_work_number_limit();

-- Backfill: every existing number's home workspace becomes its primary
-- assignment. Idempotent (ON CONFLICT DO NOTHING) so re-running never
-- duplicates or clobbers a manually curated primary flag.
insert into public.workspace_work_numbers (workspace_id, number_id, is_primary)
select n.workspace_id, n.id, true
from public.manager_sms_numbers n
where n.workspace_id is not null
on conflict (workspace_id, number_id) do nothing;

alter table public.workspace_work_numbers enable row level security;
revoke all on public.workspace_work_numbers from anon, authenticated;
grant select on public.workspace_work_numbers to authenticated;
grant all on public.workspace_work_numbers to service_role;

-- Client roles are SELECT-only, and only for a workspace the viewer OWNS —
-- the same predicate `portal_workspaces_owner_read` already uses. A shared
-- (co-managed) workspace's numbers are read server-side with the service-role
-- client via work-numbers.server.ts, exactly like every other co-manager read
-- in this codebase (portal_workspaces itself has no co-manager RLS policy
-- either). All writes (assign/unassign/provision) go through the service role.
drop policy if exists workspace_work_numbers_owner_read on public.workspace_work_numbers;
create policy workspace_work_numbers_owner_read on public.workspace_work_numbers
  for select to authenticated using (
    exists (
      select 1 from public.portal_workspaces w
      where w.id = workspace_id and w.owner_user_id = auth.uid()
    )
  );
