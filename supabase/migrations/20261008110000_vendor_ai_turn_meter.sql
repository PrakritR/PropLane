-- Vendor number AI cost bound (Oct 8). Every model turn is recorded as a usage
-- event BEFORE the model runs, so per-sender (5/hour) and per-vendor (200/day)
-- ceilings count blocked and failed attempts too. The meter never enters the
-- outbound_sms / outbound_email cap sums, which filter by meter. Additive and
-- idempotent; written for dev/test first, applied with the promote ladder.
alter table public.vendor_work_identity_usage_events
  drop constraint if exists vendor_work_identity_usage_events_meter_check;
alter table public.vendor_work_identity_usage_events
  add constraint vendor_work_identity_usage_events_meter_check
  check (meter in ('outbound_email','outbound_sms','inbound_email','inbound_sms','ai_turn'));

create index if not exists vendor_work_identity_usage_events_vendor_meter_idx
  on public.vendor_work_identity_usage_events (vendor_user_id, meter, created_at);
