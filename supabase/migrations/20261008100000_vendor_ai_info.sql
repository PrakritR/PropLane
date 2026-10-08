-- Vendor AI info (vendor work number AI, Oct 8). The structured answers the
-- vendor's text-answering assistant may share: hours, rates, how to book,
-- emergencies, anything else. Additive and idempotent; the vendor's own row
-- (service-role route pinned to user.id writes it), so no new table and the
-- account-purge manifest is unchanged.
alter table public.vendor_business_profiles
  add column if not exists ai_info jsonb not null default '{}'::jsonb;

comment on column public.vendor_business_profiles.ai_info is
  'Vendor-authored facts the AI may state when texting on the vendor work number. Keys: hours, rates, how_to_book, emergency, extra (each text, max 1000 chars, validated server-side).';
