-- Channel stays: the guest name (and a private note) a manager types for an imported Airbnb / channel booking.
--
-- Airbnb's calendar feed says only "Reserved" plus a reservation code and the last four phone digits; it never
-- carries the guest's name. The manager knows who is coming, so they record it here, keyed on the connection and the
-- feed's event UID (the same identity a stay tombstone uses). The name lives beside the synced ranges, not inside them,
-- so every sync (which rewrites imported_ranges) leaves it alone.
--
-- RLS on, NO client policy, no client grant: every read and write is a server route using the service role,
-- re-deriving the house from the connection row and checking Calendar access for the signed-in manager.
--
-- Additive and idempotent; safe to re-run.

create table if not exists public.channel_stay_details (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.external_calendar_connections (id) on delete cascade,
  source_uid text not null,
  guest_name text,
  notes text,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  constraint channel_stay_details_guest_name_check
    check (guest_name is null or char_length(guest_name) <= 120),
  constraint channel_stay_details_notes_check
    check (notes is null or char_length(notes) <= 1000),
  constraint channel_stay_details_connection_uid_key unique (connection_id, source_uid)
);

alter table public.channel_stay_details enable row level security;

revoke all on table public.channel_stay_details from anon, authenticated;
grant all on table public.channel_stay_details to service_role;
