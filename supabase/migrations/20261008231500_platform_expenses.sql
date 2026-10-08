-- Admin > Money > Finances (admin-money-1008, decision D7): PropLane's OWN expenses, entered by hand.
--
-- Admin-only. Every read and write goes through /api/admin/expenses with the service-role client
-- after requireAdminRoute(): RLS is ON with NO policies and anon / authenticated hold no privilege
-- (the PostgREST surface is public). Receipts live in the private `platform-receipts` bucket and
-- are uploaded and read only through server-minted signed URLs.
--
-- A recurring expense is ONE row: `spent_on` is its first charge, `recurrence` says monthly or
-- yearly, and `ends_on` (inclusive) stops it. The months it covers are expanded at read time
-- (src/lib/admin/platform-expense-rules.ts), so editing the row corrects every month at once.
--
-- Additive and idempotent.

create table if not exists public.platform_expenses (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  vendor text not null,
  amount_cents integer not null check (amount_cents > 0),
  currency text not null default 'usd',
  spent_on date not null,
  recurrence text not null default 'none',
  ends_on date,
  receipt_path text,
  note text not null default '',
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.platform_expenses drop constraint if exists platform_expenses_recurrence_check;
alter table public.platform_expenses add constraint platform_expenses_recurrence_check
  check (recurrence in ('none', 'monthly', 'yearly'));

alter table public.platform_expenses drop constraint if exists platform_expenses_ends_after_start_check;
alter table public.platform_expenses add constraint platform_expenses_ends_after_start_check
  check (ends_on is null or ends_on >= spent_on);

create index if not exists platform_expenses_spent_on_idx on public.platform_expenses (spent_on desc);

create or replace function public.platform_expenses_touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists platform_expenses_touch on public.platform_expenses;
create trigger platform_expenses_touch before update on public.platform_expenses
  for each row execute function public.platform_expenses_touch_updated_at();

alter table public.platform_expenses enable row level security;
revoke all on public.platform_expenses from anon, authenticated;
grant all on public.platform_expenses to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('platform-receipts', 'platform-receipts', false, 10485760,
  array['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/heic'])
on conflict (id) do nothing;
