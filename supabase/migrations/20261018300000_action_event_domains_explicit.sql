-- action_events.domain, spelled out (Oct 18 2026). 20261018120100_vendor_dispatch_engine widened the
-- check by reading the live constraint, which is correct but leaves no literal list on disk; this
-- restates the full set explicitly so the latest migration names every domain the code writes
-- (tests/unit/channel-booking-prod-shape.test.ts). Same set as dev after 20261018120100. Idempotent.
alter table public.action_events
  drop constraint if exists action_events_domain_check;
alter table public.action_events
  add constraint action_events_domain_check
    check (domain in (
      'work_order', 'payment', 'lease', 'application', 'service_request', 'tour',
      'inspection', 'task', 'message', 'move_in_form', 'vendor_banking', 'availability',
      'channel_booking', 'vendor_dispatch'
    ));
