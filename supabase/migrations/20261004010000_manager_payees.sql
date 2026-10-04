-- Payees: who a manager pays outside the vendor-invoice flow (a mortgage lender, a utility,
-- an insurer, a tax office, an HOA, an owner, a teammate). One saved row per payee so
-- "Add payment" can name the recipient and carry every detail needed to pay them.
--
-- Scope matches manager_expense_entries: one owning manager (`manager_user_id`). The
-- workspace boundary on an expense is its property; a payee is not a property row, so it
-- is the manager's own address book.
--
-- NEVER store a bank account or routing number here. `account_reference` is the lender /
-- utility account or loan number exactly as printed on the bill; the UI masks it to the
-- last four digits in lists.
--
-- Client roles read their own rows only. Every write goes through /api/manager/payees,
-- which uses the service-role client pinned to the authenticated manager
-- (docs/agents/financials.md § Payees). Idempotent and additive.

create table if not exists public.manager_payees (
  id uuid primary key default gen_random_uuid(),
  manager_user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('vendor', 'teammate', 'other')),
  payee_type text check (payee_type in ('mortgage', 'utility', 'insurance', 'tax', 'hoa', 'owner', 'management', 'other')),
  name text not null,
  account_reference text,
  email text,
  phone text,
  address text,
  pay_method text check (pay_method in ('bank_transfer', 'check', 'card', 'online', 'autopay', 'cash')),
  notes text,
  vendor_directory_id text references public.manager_vendor_records (id) on delete set null,
  teammate_user_id uuid references auth.users (id) on delete set null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists manager_payees_manager_idx
  on public.manager_payees (manager_user_id, archived_at);

alter table public.manager_payees enable row level security;

drop policy if exists manager_payees_owner_read on public.manager_payees;
create policy manager_payees_owner_read on public.manager_payees
  for select using (manager_user_id = auth.uid());

revoke insert, update, delete on public.manager_payees from anon, authenticated;

drop policy if exists test_workspace_classified_direct_deny on public.manager_payees;
create policy test_workspace_classified_direct_deny on public.manager_payees
  as restrictive for all to authenticated
  using (not (select public.is_classified_test_workspace_principal()))
  with check (not (select public.is_classified_test_workspace_principal()));

-- An expense can name who it was paid to. Deleting a payee never deletes the books.
alter table public.manager_expense_entries
  add column if not exists payee_id uuid references public.manager_payees (id) on delete set null;

create index if not exists manager_expense_entries_payee_idx
  on public.manager_expense_entries (manager_user_id, payee_id);
