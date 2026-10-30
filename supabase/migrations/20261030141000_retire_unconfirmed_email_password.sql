-- This function can retire a pre-verification password only while the Auth
-- account has never signed in, has no confirmed channel or active session,
-- and has exactly one email identity for the same address. The guarded UPDATE
-- locks the Auth row, so a concurrent confirmation which wins first makes the
-- update affect zero rows. Existing email links remain mailbox-possession proof.
create or replace function public.retire_unconfirmed_email_password(p_user_id uuid, p_email text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed_id uuid;
begin
  if p_user_id is null or p_email is null or length(btrim(p_email)) = 0 then
    return false;
  end if;
  update auth.users u
     set encrypted_password = null
   where u.id = p_user_id
     and lower(btrim(u.email)) = lower(btrim(p_email))
     and u.email_confirmed_at is null
     and u.phone_confirmed_at is null
     and u.last_sign_in_at is null
     and u.deleted_at is null
     and coalesce(u.is_sso_user, false) = false
     and not exists (select 1 from auth.sessions s where s.user_id = u.id)
     and not exists (
       select 1 from public.account_recovery_requests r
        where r.user_id = u.id and r.state in ('archiving', 'retained', 'recovering', 'purging')
     )
     and (select count(*) from auth.identities i where i.user_id = u.id) = 1
     and exists (
       select 1 from auth.identities i
        where i.user_id = u.id and i.provider = 'email'
          and lower(btrim(i.identity_data ->> 'email')) = lower(btrim(p_email))
     )
   returning u.id into changed_id;
  return changed_id is not null;
end;
$$;
revoke all on function public.retire_unconfirmed_email_password(uuid, text) from public, anon, authenticated;
grant execute on function public.retire_unconfirmed_email_password(uuid, text) to service_role;
