-- Workspace code: a short, typeable alias of one invite link (e.g. SH-7K4Q2M: two
-- initials + six base32 characters, the format generateInviteCode emits).
-- It resolves to the same row as the token, so expiry, uses and revocation are the link's own.
alter table public.manager_invite_links
  add column if not exists short_code text;

create unique index if not exists manager_invite_links_short_code_key
  on public.manager_invite_links (short_code)
  where short_code is not null;
