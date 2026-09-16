-- A work number and a work email belong to a WORKSPACE (a portal_workspaces
-- row), not to a user. Until now both tables were keyed on manager_user_id —
-- one line and one address per account — and "workspace" in the messaging
-- code meant "owner plus co-manager links", so an owner's second workspace
-- could never have a line of its own, and an account that owned no houses but
-- still carried an accepted co-manager link showed the INVITER's number inside
-- its own, unrelated workspace (PropLane, Sep 15 2026).
--
-- Additive and idempotent:
--   * workspace_id on both tables, backfilled to the owner's default
--     workspace (created on the spot when missing, the same way
--     ensure_default_portal_workspace does everywhere else);
--   * a surrogate primary key so one owner may hold several rows;
--   * one row per workspace (unique on workspace_id);
--   * manager_user_id stays as the workspace OWNER — every send/inbound path
--     that already reads it keeps reading the owner;
--   * a workspace-keyed twin of the provisioning claim lock.
-- Nothing is re-bought, re-registered or re-minted.

-- ---------------------------------------------------------------- numbers --
alter table public.manager_sms_numbers
  add column if not exists workspace_id uuid references public.portal_workspaces(id) on delete restrict;

do $$
declare r record;
begin
  for r in
    select n.manager_user_id
    from public.manager_sms_numbers n
    join public.profiles p on p.id = n.manager_user_id
    where n.workspace_id is null
  loop
    update public.manager_sms_numbers
      set workspace_id = public.ensure_default_portal_workspace(r.manager_user_id)
      where manager_user_id = r.manager_user_id and workspace_id is null;
  end loop;
end $$;

alter table public.manager_sms_numbers add column if not exists id uuid not null default gen_random_uuid();
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.manager_sms_numbers'::regclass
      and contype = 'p'
      and pg_get_constraintdef(oid) = 'PRIMARY KEY (manager_user_id)'
  ) then
    alter table public.manager_sms_numbers drop constraint manager_sms_numbers_pkey;
    alter table public.manager_sms_numbers add constraint manager_sms_numbers_pkey primary key (id);
  end if;
end $$;
create unique index if not exists manager_sms_numbers_workspace_uniq
  on public.manager_sms_numbers (workspace_id);
-- A legacy row that could not be placed (its user has no profile) keeps the
-- old one-per-user guarantee.
create unique index if not exists manager_sms_numbers_legacy_user_uniq
  on public.manager_sms_numbers (manager_user_id) where workspace_id is null;
create index if not exists manager_sms_numbers_owner_idx
  on public.manager_sms_numbers (manager_user_id);

-- ----------------------------------------------------------------- emails --
alter table public.manager_assistant_emails
  add column if not exists workspace_id uuid references public.portal_workspaces(id) on delete restrict;

do $$
declare r record;
begin
  for r in
    select e.manager_user_id
    from public.manager_assistant_emails e
    join public.profiles p on p.id = e.manager_user_id
    where e.workspace_id is null
  loop
    update public.manager_assistant_emails
      set workspace_id = public.ensure_default_portal_workspace(r.manager_user_id)
      where manager_user_id = r.manager_user_id and workspace_id is null;
  end loop;
end $$;

alter table public.manager_assistant_emails add column if not exists id uuid not null default gen_random_uuid();
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.manager_assistant_emails'::regclass
      and contype = 'p'
      and pg_get_constraintdef(oid) = 'PRIMARY KEY (manager_user_id)'
  ) then
    alter table public.manager_assistant_emails drop constraint manager_assistant_emails_pkey;
    alter table public.manager_assistant_emails add constraint manager_assistant_emails_pkey primary key (id);
  end if;
end $$;
-- One ACTIVE address per workspace; a released row may stay behind for audit.
create unique index if not exists manager_assistant_emails_workspace_active_uniq
  on public.manager_assistant_emails (workspace_id) where provision_state = 'active';
create unique index if not exists manager_assistant_emails_legacy_user_uniq
  on public.manager_assistant_emails (manager_user_id) where workspace_id is null;
create index if not exists manager_assistant_emails_owner_idx
  on public.manager_assistant_emails (manager_user_id);

-- ------------------------------------------------------- provisioning lock --
-- The workspace-keyed twin of claim_manager_sms_provisioning(uuid, uuid).
-- Same states, same request stamp, keyed on the row the workspace holds.
create or replace function public.claim_workspace_sms_provisioning(
  p_workspace_id uuid,
  p_request_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_claimed uuid;
begin
  update public.manager_sms_numbers
  set provision_state = 'provisioning',
      provision_request_id = p_request_id,
      attachment_state = 'attaching',
      attempts = attempts + 1,
      last_error = null,
      updated_at = now()
  where workspace_id = p_workspace_id
    and provision_state in ('pending_registration', 'failed')
  returning id into v_claimed;
  return v_claimed is not null;
end;
$$;
revoke execute on function public.claim_workspace_sms_provisioning(uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_workspace_sms_provisioning(uuid, uuid) to service_role;
