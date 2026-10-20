-- The Automations feature's per-workspace preset modes live in `workspace_automation_presets`.
-- 20261018200000 first created them under `workspace_automation_settings`, a name the settings
-- scope resolver already owns (20260920210000: row_data, owner_user_id), so on any database that had
-- the old table the `create table if not exists` was a no-op and the preset columns never existed.
-- 20261018200000 now creates the new name; this migration brings dev (which ran the old text) and
-- every other database to the same place. Additive and idempotent. The original table is never
-- dropped or altered here.

create table if not exists public.workspace_automation_presets (
  workspace_id uuid not null references public.portal_workspaces (id) on delete cascade,
  preset text not null check (length(preset) between 1 and 40),
  mode text not null check (mode in ('auto', 'draft', 'off')),
  template text check (template is null or length(template) <= 600),
  channel text not null default 'sms' check (channel in ('sms')),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, preset)
);

alter table public.workspace_automation_presets enable row level security;
revoke all on public.workspace_automation_presets from anon, authenticated;
grant all on public.workspace_automation_presets to service_role;

-- Carry over any rows an earlier run wrote under the old name: only when that table really has the
-- preset columns (the resolver's own row_data table does not, and is left untouched).
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'workspace_automation_settings' and column_name = 'preset'
  ) and exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'workspace_automation_settings' and column_name = 'mode'
  ) and exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'workspace_automation_settings' and column_name = 'template'
  ) then
    execute $copy$
      insert into public.workspace_automation_presets (workspace_id, preset, mode, template, updated_by, updated_at)
      select workspace_id, preset, mode, template, updated_by, coalesce(updated_at, now())
      from public.workspace_automation_settings
      where preset is not null and mode in ('auto', 'draft', 'off')
      on conflict do nothing
    $copy$;
  end if;
end $$;
