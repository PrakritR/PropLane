-- Every PropLane-held balance in one grouped read, for Admin > Money > Payouts.
-- Additive and idempotent. docs/agents/owner-management.md § Payouts and splits.
--
-- Why: the admin Payouts page folded the balances in the app, which meant scanning EVERY `party_ledger_lines` row for the
-- three accounts on each request, paged 1000 at a time, with no window and no cache. As the ledger grows that is a request
-- that times out, and past the page budget it returned short balances rather than failing. The grouping belongs in the
-- database, exactly as `platform_ledger_totals()` and `platform_fee_revenue_by_month()` already do it.
--
-- Shape: one row per (account, party, workspace), split into what has matured and what is still pending, so the caller folds
-- a party's workspaces (an owner's balance is per workspace, a vendor's spans them) without reading a single line.
-- Signed cents, as stored: the caller negates. Service-role only, like every other function on this ledger.
create or replace function public.party_ledger_balance_rollup()
returns table (account text, party_id text, workspace_id uuid, matured_cents bigint, pending_cents bigint)
language sql stable security definer set search_path = public, pg_temp as $$
  select
    l.account,
    l.party_id,
    l.workspace_id,
    coalesce(sum(l.amount_cents) filter (where l.available_on is null or l.available_on <= now()), 0)::bigint,
    coalesce(sum(l.amount_cents) filter (where l.available_on > now()), 0)::bigint
  from public.party_ledger_lines l
  where l.account in ('owner_payable', 'vendor_payable', 'proplane_fee_revenue')
  group by l.account, l.party_id, l.workspace_id;
$$;

revoke all on function public.party_ledger_balance_rollup() from public, anon, authenticated;
grant execute on function public.party_ledger_balance_rollup() to service_role;
