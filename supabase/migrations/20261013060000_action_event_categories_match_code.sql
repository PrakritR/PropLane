-- action_events_category_check must admit every NotificationCategory the code emits
-- (tours and inspections were missing, so tour/inspection/channel-booking events were rejected). Idempotent.
alter table public.action_events
  drop constraint if exists action_events_category_check;
alter table public.action_events
  add constraint action_events_category_check
    check (category in (
      'messages', 'leases', 'payments', 'maintenance', 'applications', 'tours', 'inspections', 'voice_calls', 'account'
    ));
