alter table public.action_event_deliveries
  add column if not exists sms_deferred_until timestamptz;

comment on column public.action_event_deliveries.sms_deferred_until is
  'Original SMS due time retained while another notification channel retries independently.';
