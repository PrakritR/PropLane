-- A pre-provider retry reserves the campaign allowance once per message/day.
-- The shared daily cap remains conservative even when wallet reads fail.
alter table public.sms_outbox
  add column if not exists campaign_budget_spent_on date;

create or replace function public.spend_sms_outbox_segment_budget(
  p_outbox_id uuid,
  p_worker_id text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
set timezone = 'UTC'
as $$
declare
  v_row public.sms_outbox%rowtype;
  v_today date := (now() at time zone 'UTC')::date;
begin
  select * into v_row from public.sms_outbox
    where id = p_outbox_id for update;
  if not found or p_worker_id is null or p_worker_id = ''
    or v_row.status <> 'submitting'
    or v_row.lease_owner is distinct from p_worker_id
    or v_row.lease_expires_at is null
    or v_row.lease_expires_at <= clock_timestamp() then
    raise exception 'SMS dispatch claim is no longer current';
  end if;

  if v_row.campaign_budget_spent_on = v_today then
    return true;
  end if;
  if public.spend_sms_segment_budget(v_row.segment_count) is not true then
    return false;
  end if;
  update public.sms_outbox set campaign_budget_spent_on = v_today
    where id = p_outbox_id;
  return true;
end;
$$;

revoke all on function public.spend_sms_outbox_segment_budget(uuid, text)
  from public, anon, authenticated;
grant execute on function public.spend_sms_outbox_segment_budget(uuid, text)
  to service_role;
