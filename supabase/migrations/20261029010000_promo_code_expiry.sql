-- Expiring payment-waiver codes (captain, Oct 28).
--
-- A waiver code (FREE100) used to grant paid access for life. Staff can now expire a code, or end the
-- promo on one account, and the waiver grant resolves to Free from that moment. The purchase row is
-- never rewritten: access is derived (docs/agents/plan-entitlements.md).
--
--   manager_promo_code_policies  one row per code that has an expiry decision: when it stops redeeming
--                                and every grant made with it ends. `reason` is required.
--   manager_purchases.promo_ends_at  the per-account end ("End promo" on one account).
--
-- Service-role only, like every trust-signal table: RLS is enabled with NO client policies and the
-- client roles hold no privileges. Additive and idempotent.

create table if not exists public.manager_promo_code_policies (
  code       text primary key,
  expires_at timestamptz,
  reason     text not null,
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.manager_promo_code_policies enable row level security;

revoke all on public.manager_promo_code_policies from anon, authenticated;

alter table public.manager_purchases
  add column if not exists promo_ends_at timestamptz;
