-- Additive: per-workspace Stripe Connect account + payout mode + one-time
-- auto-payout-switch confirmation, plus a debit-consent record. Entirely
-- inert until application code reads them behind the WORKSPACE_CONNECT_ENABLED
-- server flag (default off — src/lib/workspace-connect/flag.ts). With the
-- flag off nothing reads these columns/tables and every existing per-manager
-- money path (profiles.stripe_connect_account_id, the PropLane balance
-- ledger) is unchanged. See docs C186-C189/C045 (captain decision Sep 24,
-- 2026: one Stripe Connect account per WORKSPACE, manual payouts).

alter table public.portal_workspaces
  add column if not exists stripe_connect_account_id text,
  add column if not exists stripe_connect_charges_enabled boolean not null default false,
  add column if not exists stripe_connect_payouts_enabled boolean not null default false,
  add column if not exists payout_mode text not null default 'manual'
    check (payout_mode in ('manual', 'automatic')),
  add column if not exists auto_payout_switch_confirmed_at timestamptz;

create unique index if not exists portal_workspaces_stripe_connect_account_unique
  on public.portal_workspaces(stripe_connect_account_id)
  where stripe_connect_account_id is not null;

-- Who agreed to let PropLane debit their workspace's Connect balance to pay
-- a vendor or PropLane's own plan/communication billing, and the terms
-- version they agreed to. Debits refuse to run without a row here (enforced
-- in application code — src/lib/workspace-connect/resolve.server.ts — not by
-- this table alone). One row per workspace: the primary key IS the guard
-- against a second, differently-scoped consent record for the same workspace.
create table if not exists public.workspace_debit_consents (
  workspace_id uuid primary key references public.portal_workspaces(id) on delete cascade,
  consented_by uuid not null references public.profiles(id),
  consented_at timestamptz not null default now(),
  terms_version text not null
);
alter table public.workspace_debit_consents enable row level security;
revoke all on public.workspace_debit_consents from anon, authenticated;
grant all on public.workspace_debit_consents to service_role;
