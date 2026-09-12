-- Minimal dependency fixture for the 2026-09-11 production migration bundle.
-- This is deliberately not a production clone and contains no customer data.
create schema auth;
create schema storage;
create schema supabase_migrations;

create role anon nologin;
create role authenticated nologin;
create role service_role nologin;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb not null default '{}'
);

create table storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false
);

create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null,
  name text not null
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  role text,
  full_name text,
  phone text,
  preferred_language text
);

create table public.profile_roles (
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null,
  primary key (user_id, role)
);

create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null references auth.users(id)
);

create table public.ledger_entries (
  id uuid primary key default gen_random_uuid(),
  resident_user_id uuid,
  resident_email text,
  row_data jsonb not null default '{}'
);
create table public.security_deposit_ledger (like public.ledger_entries including all);
create table public.manager_payment_plans (like public.ledger_entries including all);
create table public.portal_household_charge_records (like public.ledger_entries including all);
create table public.portal_lease_pipeline_records (like public.ledger_entries including all);

create table public.vendor_invoices (
  id uuid primary key default gen_random_uuid(),
  manager_user_id uuid not null references auth.users(id) on delete cascade,
  vendor_user_id uuid not null references auth.users(id) on delete cascade,
  resident_user_id uuid,
  resident_email text,
  row_data jsonb not null default '{}'
);

create table public.vendor_payouts (like public.vendor_invoices including all);
alter table public.vendor_payouts
  add constraint vendor_payouts_manager_user_id_fixture_fkey
  foreign key (manager_user_id) references auth.users(id) on delete cascade;
alter table public.vendor_payouts
  add constraint vendor_payouts_vendor_user_id_fixture_fkey
  foreign key (vendor_user_id) references auth.users(id) on delete cascade;

create table public.ordinary_fixture (
  id uuid primary key default gen_random_uuid(),
  note text not null
);

create table supabase_migrations.schema_migrations (
  version text primary key,
  statements text[],
  name text
);

grant usage on schema public, auth, storage to anon, authenticated, service_role;
