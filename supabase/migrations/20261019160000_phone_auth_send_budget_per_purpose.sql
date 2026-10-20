-- The hourly SEND budget counted every purpose on a phone together, and `/api/public/phone-bind` lets anyone
-- holding a printed public entry code name an arbitrary phone. Three public-bind codes aimed at a victim's
-- number therefore spent the whole allowance, and for the next hour `phone_auth_start` refused their phone
-- sign-in too. The budget is now the phone's allowance FOR ONE PURPOSE (3) under a higher ceiling across every
-- purpose (8), which is the same pair the TypeScript side (`SHARED_LINE_OTP_RULES`) enforces.
-- Additive: create-or-replace only.
create or replace function public.phone_auth_start(
  p_id uuid, p_phone text, p_phone_key text, p_purpose text, p_user uuid,
  p_browser_hash text, p_code_hash text, p_provider text default 'local'
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_purpose not in ('sign_in','change_number_old','change_number_new') or p_phone !~ '^\+[1-9][0-9]{7,14}$'
    or p_browser_hash is null or p_code_hash is null or p_provider not in ('local','supabase') then return false; end if;
  if p_purpose <> 'sign_in' and p_user is null then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended('phone-auth:' || p_phone, 0));
  -- This purpose's own hourly allowance, then the phone's ceiling across every purpose.
  if (select count(*) from public.phone_otp_challenges
        where phone_key = p_phone_key and purpose = p_purpose and created_at > now() - interval '1 hour') >= 3 then return false; end if;
  if (select count(*) from public.phone_otp_challenges
        where phone_key = p_phone_key and created_at > now() - interval '1 hour') >= 8 then return false; end if;
  -- Locked phone: ten wrong codes for THIS purpose in 24 hours. No text is sent to it.
  if public.phone_auth_failed_code_count(p_phone_key, p_purpose) >= 10 then return false; end if;
  update public.phone_otp_challenges set consumed_at = now()
    where phone_key = p_phone_key and purpose = p_purpose and auth_user_id is not distinct from p_user and consumed_at is null;
  insert into public.phone_otp_challenges(id, phone_key, purpose, subject_id, auth_user_id, phone_e164, browser_hash, code_hash, auth_provider, expires_at)
    values(p_id, p_phone_key, p_purpose, p_user::text, p_user, p_phone, p_browser_hash, p_code_hash, p_provider, now() + interval '10 minutes');
  return true;
end $$;
