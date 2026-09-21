-- The workspace rung between a house's own settings override and the
-- account row (PLAN-0920-0845 phase A). One row per `portal_workspaces` id,
-- holding the same shape of namespaced `row_data` blob the account row
-- (`manager_automation_settings.row_data`) already carries: automation keys
-- plus `reminderRules`, `serviceAutomation`, `automatedMessages`,
-- `leaseAutomation`, `applicationAutomation`, `taskAutomation`, and (from this
-- plan) `paymentAutomation` and `tourSettings`. Namespace keys are documented
-- in `src/lib/settings/property-overrides.server.ts`'s `OperationsNamespace`.
--
-- Service-role only, same as `manager_automation_settings`: no client-role
-- policy is created, and both client roles are explicitly revoked, so RLS
-- being enabled blocks every row rather than needing a predicate to get
-- right. `src/lib/settings/scope-resolver.server.ts` is the only reader/
-- writer, and it always goes through the service-role client.
--
-- Idempotent and additive; safe to re-run.

create table if not exists public.workspace_automation_settings (
  workspace_id uuid primary key references public.portal_workspaces(id) on delete cascade,
  owner_user_id uuid not null references public.profiles(id) on delete cascade,
  row_data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.workspace_automation_settings enable row level security;
revoke all on public.workspace_automation_settings from public, anon, authenticated;
grant all on public.workspace_automation_settings to service_role;

-- No client-role policy exists on this table today; this is a placeholder so
-- a future policy addition follows the repo's idempotent-migration rule
-- (drop before create) rather than needing to be discovered fresh.
drop policy if exists workspace_automation_settings_service_only on public.workspace_automation_settings;

create index if not exists workspace_automation_settings_owner_idx
  on public.workspace_automation_settings(owner_user_id);

comment on table public.workspace_automation_settings is
  'Workspace-level settings rung between a property override (manager_property_records.row_data.operationsSettings) and the account row (manager_automation_settings), keyed on portal_workspaces.id. Read and written only by src/lib/settings/scope-resolver.server.ts; service role only, never a client role.';
