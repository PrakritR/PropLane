-- A retry releases only an explicitly expired inquiry, serialized with webhooks.
create or replace function public.retry_expired_resident_identity(p_resident_user_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_inquiry public.resident_identity_inquiries%rowtype;
begin
  select * into v_inquiry from public.resident_identity_inquiries
    where resident_user_id = p_resident_user_id and active for update;
  if not found or v_inquiry.status <> 'expired' then return false; end if;
  update public.resident_identity_inquiries set active = false, updated_at = now() where id = v_inquiry.id;
  update public.resident_identity_subjects set status = 'not_started', provider_decision = null,
    verified_at = null, last_event_id = null, last_event_created_at = null, updated_at = now()
    where resident_user_id = p_resident_user_id and status = 'expired';
  if not found then raise exception 'subject state changed'; end if;
  return true;
end $$;
revoke all on function public.retry_expired_resident_identity(uuid) from public, anon, authenticated;
grant execute on function public.retry_expired_resident_identity(uuid) to service_role;
