-- The 24-hour failed-code cap counted every purpose on a phone together, and `/api/public/phone-bind` lets
-- anyone holding a printed public entry code name an arbitrary phone. A handful of wrong guesses there therefore
-- locked the owner of that phone out of `sign_in` and `link_unlock` for a day. The count is now per PURPOSE,
-- which is the scope the TypeScript side (`PHONE_LIFETIME_FAILED_CODE_CAP`) uses too. The per-challenge
-- 5-attempt lock and the 3-sends-per-phone-per-hour budget are unchanged and still span every purpose.
-- Additive: one overload plus create-or-replace of the two callers.
create or replace function public.phone_auth_failed_code_count(p_phone_key text, p_purpose text)
returns integer language sql stable security definer set search_path = '' as $$
  select coalesce(sum(greatest(attempts - case when verified_at is not null then 1 else 0 end, 0)), 0)::integer
  from public.phone_otp_challenges
  where phone_key = p_phone_key and purpose = p_purpose and created_at > now() - interval '24 hours'
$$;
revoke all on function public.phone_auth_failed_code_count(text, text) from public, anon, authenticated;
grant execute on function public.phone_auth_failed_code_count(text, text) to service_role;

create or replace function public.phone_auth_start(
  p_id uuid, p_phone text, p_phone_key text, p_purpose text, p_user uuid,
  p_browser_hash text, p_code_hash text, p_provider text default 'local'
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_purpose not in ('sign_in','change_number_old','change_number_new') or p_phone !~ '^\+[1-9][0-9]{7,14}$'
    or p_browser_hash is null or p_code_hash is null or p_provider not in ('local','supabase') then return false; end if;
  if p_purpose <> 'sign_in' and p_user is null then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended('phone-auth:' || p_phone, 0));
  if (select count(*) from public.phone_otp_challenges where phone_key = p_phone_key and created_at > now() - interval '1 hour') >= 3 then return false; end if;
  -- Locked phone: ten wrong codes for THIS purpose in 24 hours. No text is sent to it.
  if public.phone_auth_failed_code_count(p_phone_key, p_purpose) >= 10 then return false; end if;
  update public.phone_otp_challenges set consumed_at = now()
    where phone_key = p_phone_key and purpose = p_purpose and auth_user_id is not distinct from p_user and consumed_at is null;
  insert into public.phone_otp_challenges(id, phone_key, purpose, subject_id, auth_user_id, phone_e164, browser_hash, code_hash, auth_provider, expires_at)
    values(p_id, p_phone_key, p_purpose, p_user::text, p_user, p_phone, p_browser_hash, p_code_hash, p_provider, now() + interval '10 minutes');
  return true;
end $$;

create or replace function public.phone_auth_consume(p_id uuid, p_user uuid, p_browser_hash text, p_code_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.phone_otp_challenges%rowtype;
begin
  select * into c from public.phone_otp_challenges where id = p_id for update;
  if not found or c.browser_hash is distinct from p_browser_hash or c.auth_user_id is distinct from p_user
    or c.consumed_at is not null or c.expires_at <= now() or c.attempts >= 5 then return null; end if;
  -- Locked phone: even the right code is refused after ten wrong ones for this purpose in 24 hours.
  if public.phone_auth_failed_code_count(c.phone_key, c.purpose) >= 10 then return null; end if;
  update public.phone_otp_challenges set attempts = attempts + 1 where id = p_id;
  if c.auth_provider = 'local' and c.code_hash <> p_code_hash then return null; end if;
  if c.auth_provider = 'local' then
    update public.phone_otp_challenges set consumed_at = now(), verified_at = now() where id = p_id;
  end if;
  return jsonb_build_object('id', c.id, 'phone', c.phone_e164, 'purpose', c.purpose, 'provider', c.auth_provider);
end $$;
