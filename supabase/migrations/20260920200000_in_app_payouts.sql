-- In-app payouts (PLAN-0920-0853): Payouts page pay-out + schedule, replacing
-- Account Links / Express dashboard. Additive on top of
-- `20260712100000_stripe_payouts_disputes.sql`'s `stripe_payouts` table.
--
-- `stripe_payout_id` becomes nullable because the in-app "Pay out" claim
-- pattern (mirrors `vendor_payouts` / `payoutVendorForWorkOrder`) writes a
-- PENDING row before the Stripe call even happens, so no Stripe id exists
-- yet; the row is updated with the real `po_...` id once Stripe returns.

alter table public.stripe_payouts alter column stripe_payout_id drop not null;

alter table public.stripe_payouts
  add column if not exists method text,
  add column if not exists vendor_user_id uuid references auth.users (id) on delete set null,
  add column if not exists initiated_in_app boolean not null default false,
  add column if not exists destination_last4 text,
  add column if not exists fee_cents integer,
  add column if not exists failure_message text;

-- Adds the "returned by the bank" status (surfaced from a `payout.failed`
-- webhook with a bank-return failure code — see
-- `normalizePayoutStatus` in `src/lib/stripe-payouts.ts`).
alter table public.stripe_payouts drop constraint if exists stripe_payouts_status_check;
alter table public.stripe_payouts
  add constraint stripe_payouts_status_check
  check (status in ('paid', 'pending', 'in_transit', 'failed', 'canceled', 'returned'));

-- The idempotent claim-before-call pattern: at most one in-app-initiated
-- payout may be "in flight" per connected account. A second concurrent
-- "Pay out" click loses this unique-index insert race, which the route turns
-- into a 409. Automatic/scheduled Stripe-initiated payouts (initiated_in_app
-- = false) are never blocked by this index.
create unique index if not exists stripe_payouts_pending_claim_unique
  on public.stripe_payouts (stripe_connect_account_id)
  where status = 'pending' and initiated_in_app;

create index if not exists stripe_payouts_vendor_user_id_idx
  on public.stripe_payouts (vendor_user_id, created_at desc)
  where vendor_user_id is not null;

-- RLS unchanged: `stripe_payouts_manager_read` already scopes every read to
-- `manager_user_id = auth.uid()`, and that column holds the vendor's own id
-- for a vendor-initiated payout (same generic `profiles.stripe_connect_account_id`
-- column vendors and managers share — see `ensureVendorConnectAccountId`), so
-- vendor rows are already correctly scoped without a separate policy.
-- Purge manifest: `vendor_user_id` classified in
-- `src/lib/auth/account-purge-manifest.ts`'s existing `stripe_payouts` entry.
