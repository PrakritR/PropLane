-- One-number W4: share links stop storing raw bearer tokens.
--
-- `portal_record_share_links` and `document_share_links` kept the raw `share_token`. A leaked table
-- or backup handed out working links. New links store only SHA-256(token) in `token_hash`; the raw
-- token is returned to the creator once and never persisted (same model as `service_share_links`).
--
-- Existing rows are backfilled so their links keep working. The raw column is READ-ONLY from now on
-- (a trigger refuses any write that sets it) and is kept for 60 days (until 2026-12-17) so a
-- rollback of the application code does not strand a live link; a follow-up migration nulls it.
-- `sha256(bytea)` is built in to Postgres 11+, so this needs no pgcrypto.

alter table public.portal_record_share_links add column if not exists token_hash text;
alter table public.document_share_links add column if not exists token_hash text;

update public.portal_record_share_links
   set token_hash = encode(sha256(convert_to(share_token, 'UTF8')), 'hex')
 where token_hash is null and share_token is not null;
update public.document_share_links
   set token_hash = encode(sha256(convert_to(share_token, 'UTF8')), 'hex')
 where token_hash is null and share_token is not null;

-- A new link has no raw token.
alter table public.portal_record_share_links alter column share_token drop not null;
alter table public.document_share_links alter column share_token drop not null;

create unique index if not exists portal_record_share_links_token_hash_idx
  on public.portal_record_share_links (token_hash) where token_hash is not null;
create unique index if not exists document_share_links_token_hash_idx
  on public.document_share_links (token_hash) where token_hash is not null;

comment on column public.portal_record_share_links.share_token is
  'LEGACY raw bearer token. Read-only; resolve by token_hash. Scheduled to be nulled after 2026-12-17.';
comment on column public.document_share_links.share_token is
  'LEGACY raw bearer token. Read-only; resolve by token_hash. Scheduled to be nulled after 2026-12-17.';

-- Read-only: refuse any insert or update that sets or changes the raw column. Clearing it (null) is allowed.
create or replace function public.forbid_raw_share_token_write()
returns trigger
language plpgsql
as $$
begin
  if new.share_token is not null
     and (tg_op = 'INSERT' or new.share_token is distinct from old.share_token) then
    raise exception 'share_token is read-only; store token_hash instead' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists portal_record_share_links_raw_token_ro on public.portal_record_share_links;
create trigger portal_record_share_links_raw_token_ro
  before insert or update on public.portal_record_share_links
  for each row execute function public.forbid_raw_share_token_write();

drop trigger if exists document_share_links_raw_token_ro on public.document_share_links;
create trigger document_share_links_raw_token_ro
  before insert or update on public.document_share_links
  for each row execute function public.forbid_raw_share_token_write();
