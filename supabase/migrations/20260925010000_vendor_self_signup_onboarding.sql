-- Vendor self-signup onboarding (night/vendor-signup). A self-serve vendor
-- (public marketing CTA, no manager invite) previously landed with a bare
-- vendor_business_profiles row: business name/contact/service-area free text
-- only. There was nowhere for that vendor to declare trades, a real service
-- area, license, or insurance BEFORE a manager links them — so they were
-- invisible to any manager search. These columns are the vendor's own record
-- (no manager link required to fill them in), additive to the existing table.
alter table public.vendor_business_profiles
  add column if not exists trades text[] not null default '{}'::text[],
  add column if not exists service_area_zips text[] not null default '{}'::text[],
  add column if not exists service_radius_miles integer,
  add column if not exists license_number text not null default '',
  add column if not exists license_doc_path text,
  add column if not exists insurance_provider text not null default '',
  add column if not exists insurance_policy_number text not null default '',
  add column if not exists insurance_expires_at date,
  add column if not exists insurance_doc_path text,
  -- Default OFF: a vendor who never finishes onboarding must never appear in
  -- a manager's directory search by accident.
  add column if not exists directory_listed boolean not null default false,
  add column if not exists onboarding_completed_at timestamptz;

-- Directory search (manager-facing "PropLane vendors" tab) filters on this
-- flag first; partial index keeps it cheap since most rows will be false.
create index if not exists vendor_business_profiles_directory_listed_idx
  on public.vendor_business_profiles (directory_listed)
  where directory_listed = true;

comment on column public.vendor_business_profiles.trades is
  'Vendor self-selected work capabilities (VENDOR_TRADE_OPTIONS), set at onboarding — independent of any manager-owned roster row.';
comment on column public.vendor_business_profiles.directory_listed is
  'When true and onboarding_completed_at is set, this vendor is discoverable in the manager-facing PropLane vendors directory (public-safe fields only — see vendorDirectoryProjection).';
