-- The bank-feed cron catches up the items it attempted LEAST recently. Ordering on last_synced_at alone
-- lets an item that keeps failing (it never advances last_synced_at) sit at the front of every run and
-- starve the rest. last_sync_attempt_at is stamped on every attempt, success or failure.
-- Additive and idempotent.

alter table public.plaid_items add column if not exists last_sync_attempt_at timestamptz;

create index if not exists plaid_items_cron_catchup_idx
  on public.plaid_items (last_sync_attempt_at nulls first, last_synced_at nulls first)
  where purpose = 'bank_feed' and status in ('active', 'error');
