/**
 * Master switch for per-workspace Stripe Connect accounts (C186-C189, C045 —
 * captain decision Sep 24, 2026: one Stripe Connect account per WORKSPACE,
 * manual payouts, withdraw-only, bank account per workspace, gated by a
 * "Bank & payouts" workspace right resolved server-side from the charge's
 * workspace, never from the request body).
 *
 * Default OFF. With it off, every existing money path (the per-manager
 * `profiles.stripe_connect_account_id` Connect account, its automatic weekly
 * Friday payout schedule, the existing PropLane balance ledger keyed on the
 * manager user) behaves exactly as it did before this feature existed —
 * `resolveWorkspaceConnectAccount` (resolve.server.ts) short-circuits to
 * `null` so every caller falls through to that unchanged legacy path.
 *
 * Migration: `supabase/migrations/20260925220000_workspace_stripe_connect.sql`
 * (additive columns on `portal_workspaces` + `workspace_debit_consents`,
 * dev/test only so far).
 */
export function workspaceConnectEnabled(): boolean {
  const raw = process.env.WORKSPACE_CONNECT_ENABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}
