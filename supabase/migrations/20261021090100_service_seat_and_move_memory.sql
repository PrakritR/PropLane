-- Two additive columns the Oct 21 review asked for. Idempotent; safe to re-run.
--
-- 1. `account_link_invites.is_service_seat` — provenance of a PropLane Service seat.
--    PropLane Service is a flag on a workspace plus memberships, and an ATTACHED workspace keeps its
--    CLIENT as `owner_user_id`, so every seat on it is granted by that same account: PropLane's own
--    helper invites and the co-managers the client invites herself are indistinguishable by inviter.
--    This marks the seats written by the admin Service path (`insertAdminMembership`), so staff can be
--    decided positively instead of inferred from who granted the row. Written only by the service-role
--    routes; clients hold no insert/update grant on this table (20260906010000).
--
-- 2. `external_calendar_connections.released_identities` — reservations that just left a feed.
--    A relink moves the same stay between two rooms of one workspace: the room that LOSES it syncs
--    before the room that gains it has stored anything, so only the losing room knows the stay was not
--    new. That memory was per-process, which a second serverless instance never sees. Keyed
--    `{ "<uid:… | code:…>": "<iso released at>" }` on the losing connection's own row, read by the
--    workspace's other connections for six hours.

alter table public.account_link_invites
  add column if not exists is_service_seat boolean not null default false;

comment on column public.account_link_invites.is_service_seat is
  'True when PropLane itself issued this seat through the admin Service path (create / attach / team-invite). A seat the workspace owner granted herself is false and is never PropLane Service staff.';

alter table public.external_calendar_connections
  add column if not exists released_identities jsonb not null default '{}'::jsonb;

comment on column public.external_calendar_connections.released_identities is
  'Reservation identities (iCal UID / reservation code) that left this feed, with the ISO instant each left. The workspace''s other channel connections read it for six hours so a relink reads as a move rather than a cancellation plus a new booking.';
