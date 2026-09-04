-- Co-manager invites expire.
--
-- `account_link_invites` had no expiry and no read path filtered on age, so a
-- pending invite from months ago stayed acceptable forever. Combined with an
-- invite that was never actually delivered (the panel suppresses the server
-- notification), that is a stale, invisible, unlimited-lifetime grant — and
-- accepting one confers module access to the assigned properties.
--
-- 30 days is the conventional window and is long enough that a manager who
-- means to chase an invite still can.
--
-- Idempotent: `add column if not exists`, and the backfill only touches rows
-- that have no value yet.

alter table public.account_link_invites
  add column if not exists expires_at timestamptz;

-- Existing pending invites get 30 days from when they were created, not from
-- now: an invite sent four months ago should read as expired immediately rather
-- than being silently renewed by this migration.
update public.account_link_invites
set expires_at = coalesce(created_at, now()) + interval '30 days'
where expires_at is null;

alter table public.account_link_invites
  alter column expires_at set default (now() + interval '30 days');

comment on column public.account_link_invites.expires_at is
  'When this invite stops being acceptable. Accepting is refused past it; the row is kept so the manager can see what lapsed.';

create index if not exists account_link_invites_pending_expiry_idx
  on public.account_link_invites (status, expires_at);
