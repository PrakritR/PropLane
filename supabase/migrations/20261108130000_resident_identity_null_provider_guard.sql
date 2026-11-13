-- Reject absent provider status before applying an identity transition.
-- Provider state must agree with the signed event before a transition is applied.
create or replace function public.apply_resident_identity_event(
  p_event_id text, p_inquiry_id text, p_reference_id uuid,
  p_event_type text, p_created_at timestamptz, p_provider_status text
) returns text language plpgsql security definer set search_path = public as $$
declare
  v_inquiry public.resident_identity_inquiries%rowtype;
  v_status text;
  v_disposition text := 'applied';
begin
  select * into v_inquiry from public.resident_identity_inquiries
    where provider_inquiry_id = p_inquiry_id and resident_user_id = p_reference_id for update;
  if not found then return 'unknown_inquiry'; end if;
  if exists (select 1 from public.resident_identity_webhook_events where event_id = p_event_id) then
    update public.resident_identity_webhook_events set signed_delivery_count = signed_delivery_count + 1,
      last_received_at = now() where event_id = p_event_id and inquiry_id = v_inquiry.id;
    return 'duplicate';
  end if;
  v_status := case p_event_type
    when 'inquiry.approved' then 'approved'
    when 'inquiry.declined' then 'declined'
    when 'inquiry.expired' then 'expired'
    when 'inquiry.failed' then 'review'
    when 'inquiry.marked-for-review' then 'review'
    when 'inquiry.completed' then 'review'
    when 'inquiry.started' then 'pending'
    when 'inquiry.created' then 'pending'
    else null end;
  if v_status is null or not v_inquiry.active or (case p_event_type
    when 'inquiry.approved' then p_provider_status = 'approved'
    when 'inquiry.declined' then p_provider_status = 'declined'
    when 'inquiry.expired' then p_provider_status = 'expired'
    when 'inquiry.failed' then p_provider_status = 'failed'
    when 'inquiry.marked-for-review' then p_provider_status in ('needs_review', 'needs-review')
    when 'inquiry.completed' then p_provider_status = 'completed'
    when 'inquiry.started' then p_provider_status in ('pending', 'started')
    when 'inquiry.created' then p_provider_status = 'created'
    else false end) is not true then v_disposition := 'ignored';
  elsif v_inquiry.last_event_created_at is not null and p_created_at <= v_inquiry.last_event_created_at then v_disposition := 'stale';
  end if;
  insert into public.resident_identity_webhook_events(event_id, resident_user_id, inquiry_id, event_type, provider_created_at, disposition)
    values (p_event_id, p_reference_id, v_inquiry.id, p_event_type, p_created_at, v_disposition);
  if v_disposition = 'applied' then
    update public.resident_identity_inquiries set status = v_status, last_event_id = p_event_id,
      last_event_created_at = p_created_at, updated_at = now() where id = v_inquiry.id;
    update public.resident_identity_subjects set status = v_status,
      provider_decision = case when p_event_type = 'inquiry.approved' then 'approved' when p_event_type = 'inquiry.declined' then 'declined' when p_event_type = 'inquiry.marked-for-review' then 'review' else null end,
      verified_at = case when v_status = 'approved' then p_created_at else null end,
      last_event_id = p_event_id, last_event_created_at = p_created_at, updated_at = now()
      where resident_user_id = p_reference_id;
  end if;
  return v_disposition;
end $$;
revoke all on function public.apply_resident_identity_event(text, text, uuid, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.apply_resident_identity_event(text, text, uuid, text, timestamptz, text) to service_role;
