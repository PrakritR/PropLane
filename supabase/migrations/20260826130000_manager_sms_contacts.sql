-- Manager-owned display labels for SMS-only contacts. These labels are never
-- identity proof, consent, or resident verification; role remains part of the
-- key so one phone can have separate prospect and resident conversations.

create table if not exists public.manager_sms_contacts (
  id uuid primary key default gen_random_uuid(),
  manager_user_id uuid not null references auth.users (id) on delete cascade,
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  counterparty_role text not null check (
    counterparty_role in ('resident', 'applicant', 'prospect', 'vendor', 'manager', 'admin', 'unknown')
  ),
  display_name text check (
    display_name is null or (char_length(trim(display_name)) between 1 and 80)
  ),
  last_inbound_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (manager_user_id, phone_e164, counterparty_role)
);

create index if not exists manager_sms_contacts_owner_updated_idx
  on public.manager_sms_contacts (manager_user_id, updated_at desc);

alter table public.manager_sms_contacts enable row level security;
revoke all on table public.manager_sms_contacts from anon, authenticated;
