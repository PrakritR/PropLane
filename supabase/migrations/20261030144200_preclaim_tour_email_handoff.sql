-- Reserve exact tour context before Auth can mint an OTP. Temporary digests are
-- random opaque placeholders, never provider credentials.
create or replace function public.preclaim_tour_email_handoff(p_digest text,p_inquiry text,p_email text,p_user uuid,p_handoff uuid,p_placeholder text)
returns boolean language plpgsql security definer set search_path='' as $$
declare cap public.tour_signup_capabilities%rowtype;
begin
 select * into cap from public.tour_signup_capabilities where token_digest=p_digest and inquiry_id=p_inquiry
   and recipient_email=pg_catalog.lower(pg_catalog.btrim(p_email)) and expires_at>now()
   and (consumed_user_id is null or consumed_user_id=p_user) for update;
 if not found or p_user is null or p_handoff is null or p_placeholder is null or p_placeholder !~ '^[0-9a-f]{64}$' then return false; end if;
 insert into public.email_onboarding_handoffs(id,user_id,token_digest,intent,tour_inquiry_id,tour_capability_id,expires_at)
 values(p_handoff,p_user,p_placeholder,'tour',p_inquiry,cap.id,now()+interval '1 hour');
 update public.tour_signup_capabilities set consumed_at=coalesce(consumed_at,now()),consumed_user_id=p_user where id=cap.id;
 return true;
exception when unique_violation then return false;
end $$;
revoke all on function public.preclaim_tour_email_handoff(text,text,text,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.preclaim_tour_email_handoff(text,text,text,uuid,uuid,text) to service_role;
create or replace function public.bind_tour_email_handoff(p_user uuid,p_handoff uuid,p_placeholder text,p_digest text)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 if p_user is null or p_handoff is null or p_placeholder is null or p_digest is null or p_digest !~ '^[0-9a-f]{64}$' then return false; end if;
 update public.email_onboarding_handoffs set token_digest=p_digest where id=p_handoff and user_id=p_user
   and token_digest=p_placeholder and intent='tour' and status='pending' and expires_at>now();
 return found;
exception when unique_violation then return false;
end $$;
revoke all on function public.bind_tour_email_handoff(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.bind_tour_email_handoff(uuid,uuid,text,text) to service_role;

-- Retire the former post-mint claim path.
revoke execute on function public.claim_tour_signup_capability(text,text,text,uuid,text) from public,anon,authenticated,service_role;
