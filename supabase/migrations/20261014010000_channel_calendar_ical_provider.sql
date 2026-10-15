-- "Other calendar" (provider 'ical'): any site that publishes a plain https .ics (Houfy, Furnished
-- Finder, Expedia...). The site's name is the connection's existing `label` column.
-- Additive and idempotent: widens the provider check and relaxes uniqueness, never touches rows.
alter table public.external_calendar_connections
  drop constraint if exists external_calendar_connections_provider_check;

alter table public.external_calendar_connections
  add constraint external_calendar_connections_provider_check
    check (provider in ('airbnb', 'booking_com', 'vrbo', 'ical'));

-- One connection per (room, channel) stays true for Airbnb, Booking.com and Vrbo. An 'ical' room may
-- hold several, one per site name (Houfy AND Furnished Finder on the same room), so the old
-- (property, room, provider) key becomes two partial keys.
alter table public.external_calendar_connections
  drop constraint if exists external_calendar_connections_property_room_provider_unique;

create unique index if not exists external_calendar_connections_room_channel_unique
  on public.external_calendar_connections (property_id, room_id, provider)
  where provider <> 'ical';

create unique index if not exists external_calendar_connections_room_ical_site_unique
  on public.external_calendar_connections (property_id, room_id, provider, lower(coalesce(label, '')))
  where provider = 'ical';
