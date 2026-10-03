alter table public.manager_property_records add column if not exists finance_worksheet jsonb not null default '{}'::jsonb;
create or replace function public.save_property_finance_worksheet(p_owner uuid, p_property text, p_path text, p_value jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare result jsonb;
begin
  if p_path <> 'capital' and p_path !~ '^reported\.[0-9]{4}(-[0-9]{2})?$' then raise exception 'Invalid worksheet path'; end if;
  update manager_property_records set finance_worksheet = case when p_path = 'capital'
    then jsonb_set(finance_worksheet, '{capital}', p_value, true)
    else jsonb_set(finance_worksheet, '{reported}', coalesce(finance_worksheet->'reported', '{}'::jsonb) || jsonb_build_object(split_part(p_path, '.', 2), p_value), true) end
    where id = p_property and manager_user_id = p_owner returning finance_worksheet into result;
  if result is null then raise exception 'Property not owned'; end if;
  return result;
end $$;
revoke all on function public.save_property_finance_worksheet(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.save_property_finance_worksheet(uuid, text, text, jsonb) to service_role;
