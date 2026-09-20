-- How a pending co-manager invite was delivered, and when.
--
-- The workspace invite sheet sends by phone, email, or PropLane code, and the
-- "Who has access" list needs to say which and how long ago rather than
-- guessing from the row's other fields. Idempotent: `add column if not
-- exists`, no backfill (existing rows simply have no delivery recorded).

alter table public.account_link_invites
  add column if not exists invited_via text,
  add column if not exists invited_at timestamptz;

comment on column public.account_link_invites.invited_via is
  'How this invite was sent: phone, email, or code. Null on rows written before this column existed.';
comment on column public.account_link_invites.invited_at is
  'When this invite was sent via invited_via. Null on rows written before this column existed.';
