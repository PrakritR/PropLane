-- Finance Phase A: a financial entry knows whether it is Paid or Due, how it was paid, which bill it covers,
-- and where its receipt lives; a recurring payable generates the next Due entry. Additive and idempotent.
--
-- Money rules (docs/agents/financials.md § Finance Phase A):
--  * PropLane records these payments; it moves no money here and holds none. `payment_method` is a plain label.
--  * A receipt is a `manager_documents` row in the PRIVATE `manager-documents` bucket, reached only through the
--    server-minted signed URL after an ownership check. This table stores its id, never a path or a URL.
--  * No client write grant: RLS is on and the owner may only READ their own rows; every write goes through a
--    route that pins `manager_user_id` to the authenticated manager with the service-role client.

alter table public.manager_expense_entries
  add column if not exists payment_status text not null default 'paid'
    check (payment_status in ('paid', 'due')),
  add column if not exists due_date date,
  add column if not exists paid_date date,
  add column if not exists payment_method text
    check (payment_method in ('p2p_transfer', 'ach', 'card', 'check', 'cash', 'other')),
  add column if not exists payee_label text,
  add column if not exists billing_period_start date,
  add column if not exists billing_period_end date,
  add column if not exists receipt_document_id uuid references public.manager_documents (id) on delete set null,
  add column if not exists duplicate_override_reason text;

create table if not exists public.manager_recurring_payables (
  id uuid primary key default gen_random_uuid(),
  manager_user_id uuid not null references auth.users (id) on delete cascade,
  label text not null,
  payee_id uuid references public.manager_payees (id) on delete set null,
  vendor_id text,
  payee_label text,
  category_code text not null,
  amount_cents bigint not null check (amount_cents > 0),
  property_id text,
  memo text,
  payment_method text
    check (payment_method in ('p2p_transfer', 'ach', 'card', 'check', 'cash', 'other')),
  frequency text not null check (frequency in ('weekly', 'monthly', 'quarterly', 'annual')),
  -- The next date a Due entry is generated for. The anchor day of month is carried by `anchor_day`.
  next_date date not null,
  anchor_day smallint not null default 1 check (anchor_day between 1 and 31),
  end_date date,
  status text not null default 'active' check (status in ('active', 'paused', 'ended')),
  last_generated_for date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists manager_recurring_payables_due_idx
  on public.manager_recurring_payables (status, next_date);
create index if not exists manager_recurring_payables_manager_idx
  on public.manager_recurring_payables (manager_user_id, status);

alter table public.manager_expense_entries
  add column if not exists recurring_payable_id uuid references public.manager_recurring_payables (id) on delete set null;

-- One generated entry per payable per due date: the cron and a retry can never double-generate.
create unique index if not exists manager_expense_entries_recurring_due_unique
  on public.manager_expense_entries (recurring_payable_id, due_date)
  where recurring_payable_id is not null;

create index if not exists manager_expense_entries_status_due_idx
  on public.manager_expense_entries (manager_user_id, payment_status, due_date);

alter table public.manager_recurring_payables enable row level security;

drop policy if exists manager_recurring_payables_owner_read on public.manager_recurring_payables;
create policy manager_recurring_payables_owner_read on public.manager_recurring_payables
  for select to authenticated using (manager_user_id = auth.uid());

-- Supabase default privileges hand anon/authenticated every right on a new table (TRUNCATE bypasses RLS):
-- take them all back, then give the owner's session the one read it needs.
revoke all on public.manager_recurring_payables from anon, authenticated;
grant select on public.manager_recurring_payables to authenticated;
