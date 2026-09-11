-- A vendor's own business record. Until now a vendor's "profile" lived only on
-- the manager's directory row for them (manager_vendor_records.row_data), so a
-- vendor with no manager link yet could not save anything and a vendor linked
-- to three managers had three copies. This row is theirs: one per vendor
-- account, readable by the vendor, written only through the vendor profile
-- route (service role). Managers still see the directory row; the route mirrors
-- the shared fields (name, phone, email) into every linked directory row on
-- save, as it did before.
create table if not exists public.vendor_business_profiles (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  business_name text not null default '',
  contact_name text not null default '',
  work_email text not null default '',
  work_phone text not null default '',
  service_area text not null default '',
  notify_new_offers boolean not null default true,
  notify_schedule_changes boolean not null default true,
  notify_payments boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.vendor_business_profiles enable row level security;
revoke all on public.vendor_business_profiles from anon, authenticated;
grant select on public.vendor_business_profiles to authenticated;
grant all on public.vendor_business_profiles to service_role;
drop policy if exists vendor_business_profiles_owner_read on public.vendor_business_profiles;
create policy vendor_business_profiles_owner_read on public.vendor_business_profiles
  for select to authenticated using (user_id = auth.uid());
