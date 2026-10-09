-- Listing sites: which listing site a lead came from.
--
-- The public listing link a manager posts carries `?src=<channelId>`; the public listing page
-- keeps the allowlisted value in a first-party cookie (`pl_src`), and the server routes that
-- create a tour request or an application copy it here. The value is checked against a fixed
-- channel allowlist in code before it is written, so this column only ever holds a channel id
-- (or null for direct / untagged traffic).
--
-- `posted_url` is the link the manager pasted when they marked a by-hand post as posted.
--
-- Additive and idempotent; no backfill, no RLS or grant changes (the tables keep their policies).

alter table public.manager_application_records
  add column if not exists source_channel text;

alter table public.portal_schedule_records
  add column if not exists source_channel text;

alter table public.listing_channel_posts
  add column if not exists posted_url text;

create index if not exists manager_application_records_source_channel_idx
  on public.manager_application_records (property_id, source_channel)
  where source_channel is not null;

create index if not exists portal_schedule_records_source_channel_idx
  on public.portal_schedule_records (property_id, source_channel)
  where source_channel is not null;
