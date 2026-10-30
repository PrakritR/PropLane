create table if not exists public.tour_signup_capabilities (
  id uuid primary key default gen_random_uuid(),
  token_digest text not null unique,
  inquiry_id text not null,
  recipient_email text not null,
  manager_user_id uuid not null references auth.users(id) on delete cascade,
  property_id text not null,
  tour_group_id text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  check (expires_at > created_at)
);
alter table public.tour_signup_capabilities enable row level security;
revoke all on public.tour_signup_capabilities from public, anon, authenticated;
grant all on public.tour_signup_capabilities to service_role;
create index if not exists tour_signup_capabilities_email_idx on public.tour_signup_capabilities(recipient_email);
create index if not exists tour_signup_capabilities_expiry_idx on public.tour_signup_capabilities(expires_at);
alter table public.email_onboarding_handoffs add column if not exists tour_capability_id uuid references public.tour_signup_capabilities(id) on delete cascade;
create or replace function public.claim_tour_signup_capability(p_digest text, p_inquiry_id text, p_email text, p_user_id uuid, p_token_digest text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare cap_id uuid;
begin
  update public.tour_signup_capabilities set consumed_at = now()
  where token_digest = p_digest and inquiry_id = p_inquiry_id and recipient_email = p_email
    and consumed_at is null and expires_at > now()
  returning id into cap_id;
  if cap_id is null then return false; end if;
  insert into public.email_onboarding_handoffs (user_id, token_digest, intent, tour_inquiry_id, tour_capability_id, expires_at)
  values (p_user_id, p_token_digest, 'tour', p_inquiry_id, cap_id, now() + interval '1 hour');
  return true;
end;
$$;
revoke all on function public.claim_tour_signup_capability(text,text,text,uuid,text) from public, anon, authenticated;
grant execute on function public.claim_tour_signup_capability(text,text,text,uuid,text) to service_role;
create or replace function public.purge_expired_tour_signup_capabilities()
returns integer language plpgsql security definer set search_path = '' as $$
declare removed integer;
begin
  delete from public.tour_signup_capabilities where id in (
    select c.id from public.tour_signup_capabilities c
    where c.expires_at < now() and not exists (select 1 from public.email_onboarding_handoffs h where h.tour_capability_id = c.id and h.expires_at > now())
    order by c.expires_at limit 100
  );
  get diagnostics removed = row_count;
  return removed;
end;
$$;
revoke all on function public.purge_expired_tour_signup_capabilities() from public, anon, authenticated;
grant execute on function public.purge_expired_tour_signup_capabilities() to service_role;
