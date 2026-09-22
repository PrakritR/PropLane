-- Per-door billing, step 1: door count (PLAN-0921 per-door billing). One row
-- per manager account per billing period, holding the door total AND the
-- per-listing breakdown that explains it. Billing reads THIS table, never a
-- live count (`src/lib/billing/door-count.server.ts`), so an account's
-- listings can keep changing mid-cycle without moving a bill already issued.
--
-- Service-role only, same pattern as `workspace_automation_settings`
-- (20260920210000): RLS enabled, no client-role policy, both client roles
-- explicitly revoked. `src/lib/billing/door-count-snapshot.server.ts` is the
-- only writer and always goes through the service-role client.
--
-- Idempotent and additive; safe to re-run.

create table if not exists public.manager_door_count_snapshots (
  id uuid primary key default gen_random_uuid(),
  manager_user_id uuid not null references auth.users (id) on delete cascade,
  period_start date not null,
  total_doors integer not null check (total_doors > 0),
  breakdown jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.manager_door_count_snapshots enable row level security;
revoke all on public.manager_door_count_snapshots from public, anon, authenticated;
grant all on public.manager_door_count_snapshots to service_role;

-- No client-role policy exists on this table; placeholder so a future policy
-- addition follows the repo's idempotent-migration rule (drop before create)
-- rather than needing to be discovered fresh.
drop policy if exists manager_door_count_snapshots_service_only on public.manager_door_count_snapshots;

-- One snapshot per account per billing period. `takeManagerDoorCountSnapshot`
-- upserts on this exact pair, which is what makes taking/refreshing a
-- snapshot idempotent rather than accumulating duplicate rows.
create unique index if not exists manager_door_count_snapshots_account_period_unique
  on public.manager_door_count_snapshots (manager_user_id, period_start);

create index if not exists manager_door_count_snapshots_manager_user_id_idx
  on public.manager_door_count_snapshots (manager_user_id, period_start desc);

comment on table public.manager_door_count_snapshots is
  'Per-account, per-billing-period door count snapshot for per-door billing. Read and written only by src/lib/billing/door-count-snapshot.server.ts; service role only. Billing must read this table, never a live door count, so a mid-cycle listing edit cannot move a bill already issued.';
