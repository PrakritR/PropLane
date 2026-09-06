-- Open co-manager invite links: a pending row can exist before anyone has
-- claimed it. The shareable URL carries an unguessable token; only the hash
-- is stored. Empty invitee columns mean "waiting for someone to join".
--
-- Idempotent: drop/add constraints and add-column-if-not-exists.

alter table public.account_link_invites
  alter column invitee_user_id drop not null;

alter table public.account_link_invites
  alter column invitee_axis_id drop not null;

alter table public.account_link_invites
  drop constraint if exists account_link_invites_no_self;

alter table public.account_link_invites
  add constraint account_link_invites_no_self
  check (invitee_user_id is null or inviter_user_id <> invitee_user_id);

alter table public.account_link_invites
  add column if not exists invite_token_hash text;

comment on column public.account_link_invites.invite_token_hash is
  'SHA-256 hex of the one-time open-invite token. Null on PropLane-ID invites. The raw token is never stored.';

create unique index if not exists account_link_invites_token_hash_uidx
  on public.account_link_invites (invite_token_hash)
  where invite_token_hash is not null;

-- One unused open link per owner + tab. Creating another replaces/reuses it.
create unique index if not exists account_link_invites_one_open_pending
  on public.account_link_invites (inviter_user_id, tab_kind)
  where status = 'pending' and invitee_user_id is null;

-- Retain the open-link entitlement provenance after the one-time hash is cleared.
-- Legacy direct-ID links retain their existing both-participants-paid policy.
alter table public.account_link_invites
  add column if not exists invitee_plan_inherited boolean not null default false;

-- Only server routes may mint provenance or token hashes. RLS already exposes
-- SELECT alone; also deny table writes to browser roles explicitly.
revoke insert, update, delete on public.account_link_invites from anon, authenticated;
