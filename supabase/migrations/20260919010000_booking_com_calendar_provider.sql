-- Booking.com uses the same two-way iCal path as Airbnb. One room may hold both.
alter table public.external_calendar_connections
  drop constraint if exists external_calendar_connections_provider_check;

alter table public.external_calendar_connections
  add constraint external_calendar_connections_provider_check
    check (provider in ('airbnb', 'booking_com'));
