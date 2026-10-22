-- Two additive columns the Oct 21 review asked for, plus a one-off backfill of the seats PropLane already
-- issued. Idempotent; safe to re-run.
--
-- 1. `account_link_invites.is_service_seat` — provenance of a PropLane Service seat.
--    PropLane Service is a flag on a workspace plus memberships, and an ATTACHED workspace keeps its
--    CLIENT as `owner_user_id`, so every seat on it is granted by that same account: PropLane's own
--    helper invites and the co-managers the client invites herself are indistinguishable by inviter.
--    This marks the seats written by the admin Service path (`insertAdminMembership`), so staff can be
--    decided positively instead of inferred from who granted the row. Written only by the service-role
--    routes; clients hold no insert/update grant on this table (20260906010000).
--
--    The backfill below marks the seats that path had already written, by the provenance those rows carry:
--    the seat holder is a PropLane person (the platform admin role, the always-admin ops address, or the
--    platform service owner), or the admin Service route left an audit row naming that invitee on that
--    workspace (`admin_service_team_invite` / `admin_service_team_add`, which write their audit entry BEFORE
--    the seat). Everything else - every seat a client granted herself - stays false, which is the point of
--    the column. A non-admin helper seated before this migration and without an audit row must be
--    re-invited; nothing can reconstruct their provenance.
--
-- 2. `external_calendar_connections.released_identities` — reservations that just left a feed.
--    A relink moves the same stay between two rooms of one workspace: the room that LOSES it syncs
--    before the room that gains it has stored anything, so only the losing room knows the stay was not
--    new. That memory was per-process, which a second serverless instance never sees. Keyed
--    `{ "<uid:… | code:…>": "<iso released at>" }` on the losing connection's own row, read by the
--    workspace's other connections for one hour.

alter table public.account_link_invites
  add column if not exists is_service_seat boolean not null default false;

comment on column public.account_link_invites.is_service_seat is
  'True when PropLane itself issued this seat through the admin Service path (create / attach / team-invite). A seat the workspace owner granted herself is false and is never PropLane Service staff.';

-- Backfill: accepted operator seats on a service workspace whose provenance is still readable.
update public.account_link_invites l
set is_service_seat = true
where l.is_service_seat = false
  and l.status = 'accepted'
  and l.workspace_id is not null
  and lower(btrim(coalesce(l.team_role, ''))) in ('admin', 'full')
  and exists (
    select 1 from public.portal_workspaces w
    where w.id = l.workspace_id and w.is_service
  )
  and (
    exists (
      select 1 from public.profile_roles r
      where r.user_id = l.invitee_user_id and r.role = 'admin'
    )
    or exists (
      select 1 from public.profiles p
      where p.id = l.invitee_user_id
        and (
          lower(btrim(coalesce(p.role, ''))) = 'admin'
          or lower(btrim(coalesce(p.email, ''))) = 'founders@axis-seattle-housing.com'
        )
    )
    or exists (
      select 1 from public.platform_service_settings s
      where s.owner_user_id = l.invitee_user_id
    )
    or exists (
      select 1 from public.audit_log a
      where a.action in ('admin_service_team_invite', 'admin_service_team_add')
        and a.input_summary ->> 'inviteeUserId' = l.invitee_user_id::text
        and a.input_summary ->> 'workspaceId' = l.workspace_id::text
    )
  );

alter table public.external_calendar_connections
  add column if not exists released_identities jsonb not null default '{}'::jsonb;

comment on column public.external_calendar_connections.released_identities is
  'Reservation identities (iCal UID / reservation code) that left this feed, with the ISO instant each left. The workspace''s other channel connections read it for an hour so a relink reads as a move rather than a cancellation plus a new booking.';
