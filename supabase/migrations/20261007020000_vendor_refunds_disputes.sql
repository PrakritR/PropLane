-- Vendor refunds on the central rail + disputes (vendor-banking-1006 part B).
-- Additive and idempotent. Client roles get SELECT on their own rows only;
-- every write goes through the service role (src/lib/vendor-banking/*).

-- 1) A vendor-initiated refund request: one row per stable attempt key. The
--    money itself lives on platform_hold_refund_attempts (the central rail);
--    this row carries what the vendor typed (reason) and the figures the
--    Refunds tab lists. Status mirrors the rail attempt.
create table if not exists public.vendor_payout_refunds (
  id uuid primary key default gen_random_uuid(),
  attempt_key text not null unique,
  vendor_user_id uuid not null references auth.users (id) on delete cascade,
  manager_user_id uuid not null references auth.users (id) on delete cascade,
  payout_id uuid not null references public.vendor_payouts (id) on delete cascade,
  gross_cents integer not null check (gross_cents > 0),
  fee_share_cents integer not null default 0 check (fee_share_cents >= 0),
  net_debit_cents integer not null default 0 check (net_debit_cents >= 0),
  reason text not null default '',
  status text not null default 'pending' check (status in ('pending', 'succeeded', 'failed')),
  stripe_refund_id text,
  books_settled_at timestamptz,
  notified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists vendor_payout_refunds_vendor_idx
  on public.vendor_payout_refunds (vendor_user_id, created_at desc);
create index if not exists vendor_payout_refunds_manager_idx
  on public.vendor_payout_refunds (manager_user_id, created_at desc);
create index if not exists vendor_payout_refunds_payout_idx
  on public.vendor_payout_refunds (payout_id);

alter table public.vendor_payout_refunds enable row level security;
drop policy if exists vendor_payout_refunds_party_read on public.vendor_payout_refunds;
create policy vendor_payout_refunds_party_read on public.vendor_payout_refunds
  for select using (vendor_user_id = auth.uid() or manager_user_id = auth.uid());
revoke all on table public.vendor_payout_refunds from anon, authenticated;
grant select on table public.vendor_payout_refunds to authenticated;
grant all on table public.vendor_payout_refunds to service_role;

-- 2) The manager's side of a vendor refund: the expense that came back. An
--    expense row cannot be negative (manager_expense_entries.amount_cents > 0),
--    so the reversal is its own append-only row, keyed on the attempt, beside
--    the balanced GL entry (source_type 'refund', source_id 'vendor-refund:<key>').
create table if not exists public.manager_expense_reversals (
  id uuid primary key default gen_random_uuid(),
  attempt_key text not null unique,
  manager_user_id uuid not null references auth.users (id) on delete cascade,
  payout_id uuid references public.vendor_payouts (id) on delete set null,
  vendor_invoice_id uuid references public.vendor_invoices (id) on delete set null,
  bill_id uuid references public.manager_bills (id) on delete set null,
  property_id text,
  vendor_id text,
  category_code text not null,
  amount_cents integer not null check (amount_cents > 0),
  reversal_date date not null,
  memo text,
  created_at timestamptz not null default now()
);
create index if not exists manager_expense_reversals_manager_idx
  on public.manager_expense_reversals (manager_user_id, reversal_date);

alter table public.manager_expense_reversals enable row level security;
drop policy if exists manager_expense_reversals_owner_read on public.manager_expense_reversals;
create policy manager_expense_reversals_owner_read on public.manager_expense_reversals
  for select using (manager_user_id = auth.uid());
revoke all on table public.manager_expense_reversals from anon, authenticated;
grant select on table public.manager_expense_reversals to authenticated;
grant all on table public.manager_expense_reversals to service_role;

-- 3) Refunded state on the invoice and the bill. Always written as the
--    payout's own refunded_gross_cents (absolute, never incremented), so a
--    replayed settlement can only write the same number.
alter table public.vendor_invoices add column if not exists refunded_cents integer not null default 0;
alter table public.manager_bills add column if not exists refunded_cents integer not null default 0;

-- 4) Disputes on a vendor's charge. `frozen_cents` is what the vendor cannot
--    withdraw or be refunded against while the dispute is open; it is NOT a
--    ledger line (the ledger tracks Stripe's real balance). A lost dispute
--    writes one debit line on close; a won one just clears the freeze.
create table if not exists public.vendor_banking_disputes (
  id uuid primary key default gen_random_uuid(),
  stripe_dispute_id text not null unique,
  stripe_charge_id text not null,
  vendor_user_id uuid not null references auth.users (id) on delete cascade,
  manager_user_id uuid not null references auth.users (id) on delete cascade,
  payout_id uuid not null references public.vendor_payouts (id) on delete cascade,
  amount_cents integer not null check (amount_cents > 0),
  frozen_cents integer not null default 0 check (frozen_cents >= 0),
  status text not null,
  reason text,
  outcome text check (outcome in ('won', 'lost', 'warning_closed')),
  opened_notified_at timestamptz,
  closed_notified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists vendor_banking_disputes_vendor_idx
  on public.vendor_banking_disputes (vendor_user_id, created_at desc);
create index if not exists vendor_banking_disputes_payout_idx
  on public.vendor_banking_disputes (payout_id);

alter table public.vendor_banking_disputes enable row level security;
drop policy if exists vendor_banking_disputes_party_read on public.vendor_banking_disputes;
create policy vendor_banking_disputes_party_read on public.vendor_banking_disputes
  for select using (vendor_user_id = auth.uid() or manager_user_id = auth.uid());
revoke all on table public.vendor_banking_disputes from anon, authenticated;
grant select on table public.vendor_banking_disputes to authenticated;
grant all on table public.vendor_banking_disputes to service_role;

-- 5) The vendor statement learns the dispute line.
alter table public.vendor_banking_ledger_entries drop constraint if exists vendor_banking_ledger_entries_kind_check;
alter table public.vendor_banking_ledger_entries add constraint vendor_banking_ledger_entries_kind_check
  check (kind in ('charge', 'platform_fee', 'hold', 'transfer', 'withdrawal', 'refund', 'adjustment', 'dispute'));
alter table public.vendor_banking_ledger_entries drop constraint if exists vendor_banking_ledger_entries_source_check;
alter table public.vendor_banking_ledger_entries add constraint vendor_banking_ledger_entries_source_check
  check (source in ('work_order', 'invoice', 'withdrawal', 'refund', 'hold_expiry', 'adjustment', 'dispute'));
