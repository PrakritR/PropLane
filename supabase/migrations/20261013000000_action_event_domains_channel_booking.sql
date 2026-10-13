-- Root cause of "no Airbnb booking alert, ever": action_events_domain_check still listed
-- only the domains up to 0915, so the insert for `channel_booking` (and `availability`,
-- `move_in_form`, `vendor_banking`) was rejected by the database and the sync's best-effort
-- catch swallowed it. Idempotent.
alter table public.action_events
  drop constraint if exists action_events_domain_check;
alter table public.action_events
  add constraint action_events_domain_check
    check (domain in (
      'work_order', 'payment', 'lease', 'application', 'service_request', 'tour',
      'inspection', 'task', 'message', 'move_in_form', 'vendor_banking', 'availability',
      'channel_booking'
    ));
