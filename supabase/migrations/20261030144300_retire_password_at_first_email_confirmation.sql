-- First mailbox proof must not leave a password chosen before that proof usable.
-- This migration only installs a trigger; it does not update existing users.
create or replace function public.retire_password_at_first_email_confirmation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.email_confirmed_at is null and new.email_confirmed_at is not null
     and old.last_sign_in_at is null and old.phone_confirmed_at is null
     and old.deleted_at is null and new.deleted_at is null
     and not coalesce(old.is_sso_user, false) and not coalesce(new.is_sso_user, false)
     and not exists (select 1 from auth.sessions s where s.user_id = old.id)
     and nullif(new.encrypted_password, '') is not null then
    if nullif(pg_catalog.btrim(new.email), '') is null
       or pg_catalog.lower(pg_catalog.btrim(old.email)) is distinct from pg_catalog.lower(pg_catalog.btrim(new.email))
       or exists (
         select 1 from public.account_recovery_requests r
          where r.user_id = old.id and r.state in ('archiving', 'retained', 'recovering', 'purging')
       )
       or not exists (
         select 1 from auth.identities i
          where i.user_id = old.id and i.provider = 'email'
            and pg_catalog.lower(pg_catalog.btrim(i.identity_data ->> 'email')) = pg_catalog.lower(pg_catalog.btrim(new.email))
       ) then
      raise exception 'Email confirmation requires review';
    end if;
    new.encrypted_password := null;
  end if;
  return new;
end;
$$;
revoke all on function public.retire_password_at_first_email_confirmation() from public, anon, authenticated, service_role;
drop trigger if exists retire_password_at_first_email_confirmation on auth.users;
create trigger retire_password_at_first_email_confirmation
before update of email_confirmed_at on auth.users
for each row execute function public.retire_password_at_first_email_confirmation();
