-- Vendor account W-9 (vendor-banking-1006, Finances > Tax info).
--
-- ONE W-9 per vendor ACCOUNT (primary key vendor_user_id), unlike the legacy
-- per-manager `vendor_tax_profiles` rows (manager_user_id, vendor_id) that the
-- manager's 1099 export reads. The TIN is stored only as AES-256-GCM ciphertext
-- (src/lib/reports/tin-crypto.ts) plus its last four digits; the plaintext is
-- never stored, returned or logged.
--
-- Additive and idempotent. RLS is enabled with NO anon/authenticated policy and
-- no grant: every read and write goes through /api/vendor/finances/tax with the
-- service-role client pinned to the signed-in user's id.
create table if not exists public.vendor_account_tax_profiles (
  vendor_user_id uuid primary key references auth.users (id) on delete cascade,
  legal_name text,
  business_name text,
  entity_type text,
  address_line1 text,
  address_line2 text,
  city text,
  state text,
  zip text,
  tin_type text,
  tin_ciphertext text,
  tin_last4 text,
  w9_attestation boolean not null default false,
  w9_received_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.vendor_account_tax_profiles drop constraint if exists vendor_account_tax_profiles_entity_type_check;
alter table public.vendor_account_tax_profiles add constraint vendor_account_tax_profiles_entity_type_check
  check (entity_type is null or entity_type in (
    'individual', 'single_member_llc', 'c_corp', 's_corp', 'partnership', 'llc_c', 'llc_s', 'llc_p', 'trust_estate', 'other'
  ));

alter table public.vendor_account_tax_profiles drop constraint if exists vendor_account_tax_profiles_tin_type_check;
alter table public.vendor_account_tax_profiles add constraint vendor_account_tax_profiles_tin_type_check
  check (tin_type is null or tin_type in ('ssn', 'ein'));

alter table public.vendor_account_tax_profiles enable row level security;

revoke all on table public.vendor_account_tax_profiles from anon, authenticated;
