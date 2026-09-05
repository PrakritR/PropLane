-- Stripe invoicing for pay-as-you-go communication usage.
--
-- Usage was recorded but never charged. These columns are what makes a usage
-- event billable exactly once: `stripe_invoice_item_id` records the Stripe
-- object it became, and `billed_at` is the marker the sweeper filters on. A row
-- with neither is unbilled; a row with both is done and never re-pushed.
alter table public.manager_comms_usage_events
  add column if not exists stripe_invoice_item_id text,
  add column if not exists billed_at timestamptz;

-- The sweeper's only query: this manager's unbilled events, oldest first.
create index if not exists manager_comms_usage_events_unbilled_idx
  on public.manager_comms_usage_events (manager_user_id, created_at)
  where billed_at is null;

-- One Stripe invoice item per usage event, enforced by the database rather than
-- by the sweeper remembering to check. A retry that races itself cannot bill
-- the same event twice.
create unique index if not exists manager_comms_usage_events_invoice_item_uidx
  on public.manager_comms_usage_events (stripe_invoice_item_id)
  where stripe_invoice_item_id is not null;

alter table public.manager_comms_billing_accounts
  add column if not exists stripe_customer_id text,
  add column if not exists last_invoiced_at timestamptz,
  add column if not exists last_invoice_id text;
