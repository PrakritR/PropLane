-- Retry a delivery attempt only for the same still-pending handoff. A digest
-- collision with any other context leaves the capability untouched.
create or replace function public.claim_tour_signup_capability(p_digest text, p_inquiry_id text, p_email text, p_user_id uuid, p_token_digest text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare cap public.tour_signup_capabilities%rowtype;
        handoff public.email_onboarding_handoffs%rowtype;
begin
  select * into cap from public.tour_signup_capabilities
  where token_digest = p_digest and inquiry_id = p_inquiry_id
    and recipient_email = pg_catalog.lower(pg_catalog.btrim(p_email))
    and (consumed_user_id is null or consumed_user_id = p_user_id)
    and expires_at > now() for update;
  if not found then return false; end if;

  insert into public.email_onboarding_handoffs (user_id, token_digest, intent, tour_inquiry_id, tour_capability_id, expires_at)
  values (p_user_id, p_token_digest, 'tour', p_inquiry_id, cap.id, now() + interval '1 hour')
  on conflict (token_digest) do nothing;

  select * into handoff from public.email_onboarding_handoffs
  where token_digest = p_token_digest for update;
  if not found or handoff.user_id is distinct from p_user_id
     or handoff.tour_capability_id is distinct from cap.id
     or handoff.intent is distinct from 'tour'
     or handoff.tour_inquiry_id is distinct from p_inquiry_id
     or handoff.status is distinct from 'pending'
     or handoff.expires_at <= now() then return false; end if;

  update public.tour_signup_capabilities set consumed_at = coalesce(consumed_at, now()), consumed_user_id = p_user_id
  where id = cap.id;
  return true;
end;
$$;
revoke all on function public.claim_tour_signup_capability(text,text,text,uuid,text) from public, anon, authenticated;
grant execute on function public.claim_tour_signup_capability(text,text,text,uuid,text) to service_role;
