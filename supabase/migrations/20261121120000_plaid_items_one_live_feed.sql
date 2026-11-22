-- Follow-up for databases that already ran 20261118120000 (which now carries both changes inline):
--
-- 1. plaid_items.workspace_id is dropped. It was never written and never read: a Plaid item belongs to
--    the owner who linked it (the access token's AAD binds it to that user id) and points at
--    manager_bank_accounts, which is itself owner-keyed with no workspace of its own. The managed-workspace
--    mover classifies plaid_items as 'keep' on owner_user_id for the same reason. A column that is always
--    null is an invitation to a later reader to scope a bank feed by it, so it goes.
-- 2. One live bank feed per bank account, enforced in the database. A second Link session mints a fresh
--    item_id, so the application-level dedupe on item_id cannot see it; two items on one account post the
--    same real transactions under their own transaction ids, double-posting every line.
--
-- Both steps are idempotent. The index creation fails if a database already holds a duplicate live feed,
-- which is the correct outcome: that account's statement lines need a human before the invariant is pinned.

alter table public.plaid_items drop column if exists workspace_id;

create unique index if not exists plaid_items_one_live_bank_feed_key
  on public.plaid_items (bank_account_id)
  where bank_account_id is not null and purpose = 'bank_feed' and status <> 'revoked';
