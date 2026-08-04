-- Track when a paid work number's SERVICE was suspended (manager downgraded
-- off Pro/Business). The number stays assigned for a 90-day grace so people
-- who wrote it down are not cut off overnight; a daily sweep warns, then
-- releases (Twilio + DB) after the grace. Additive only — existing rows keep
-- null until the next suspension detection stamps them.

alter table public.manager_sms_numbers
  add column if not exists service_suspended_at timestamptz,
  add column if not exists suspension_warned_at timestamptz;

create index if not exists manager_sms_numbers_service_suspended_at_idx
  on public.manager_sms_numbers (service_suspended_at)
  where service_suspended_at is not null and provision_state = 'active';
