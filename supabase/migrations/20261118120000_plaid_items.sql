-- Plaid items: one row per linked bank login. Service role only (no client grants).
-- The access token is stored encrypted (AES-256-GCM, AAD bound to owner + row id);
-- only institution, account name and the last four digits are kept in the clear.
create table if not exists public.plaid_items (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  purpose text not null check (purpose in ('bank_feed', 'resident_pay', 'income')),
  item_id text not null,
  access_token_enc text not null,
  institution_name text,
  account_mask text check (account_mask is null or account_mask ~ '^[0-9A-Za-z]{1,4}$'),
  account_name text,
  plaid_account_id text,
  bank_account_id uuid references public.manager_bank_accounts (id) on delete set null,
  transactions_cursor text,
  status text not null default 'active' check (status in ('active', 'login_required', 'error', 'revoked')),
  last_error text,
  last_synced_at timestamptz,
  sync_lock_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists plaid_items_item_id_key on public.plaid_items (item_id);
create index if not exists plaid_items_owner_purpose_idx on public.plaid_items (owner_user_id, purpose);
create index if not exists plaid_items_bank_account_idx on public.plaid_items (bank_account_id) where bank_account_id is not null;

-- One LIVE bank feed per bank account. Plaid mints a fresh item_id per Link session, so a second
-- "Connect bank" on an account that already has one would insert a second item, and both would post
-- the same real transactions under their own transaction ids: every line twice, and every balance
-- derived from the line sums wrong. A revoked item is excluded so the account can be linked again.
create unique index if not exists plaid_items_one_live_bank_feed_key
  on public.plaid_items (bank_account_id)
  where bank_account_id is not null and purpose = 'bank_feed' and status <> 'revoked';

alter table public.plaid_items enable row level security;
revoke all on public.plaid_items from public, anon, authenticated;
grant all on public.plaid_items to service_role;

-- A bank-feed statement line is idempotent on Plaid's transaction id.
alter table public.manager_bank_statement_lines add column if not exists plaid_transaction_id text;
create unique index if not exists manager_bank_statement_lines_plaid_txn_key
  on public.manager_bank_statement_lines (plaid_transaction_id);
