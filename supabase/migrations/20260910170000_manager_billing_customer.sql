-- Separate manager billing identity from resident rent-payment customer identities.
alter table public.manager_comms_billing_accounts
  add column if not exists stripe_customer_id text;
create unique index if not exists manager_billing_customer_unique
  on public.manager_comms_billing_accounts(stripe_customer_id) where stripe_customer_id is not null;
