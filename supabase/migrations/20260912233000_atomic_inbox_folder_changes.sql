create or replace function public.change_portal_inbox_thread_folders(
  p_ids text[], p_scope text, p_action text
) returns text language plpgsql security definer set search_path = public as $$
declare changed integer;
begin
  if coalesce(cardinality(p_ids), 0) = 0 or p_scope is null or p_action not in ('archive', 'restore') then
    return 'invalid';
  end if;
  if (select count(*) from public.portal_inbox_thread_records where id = any(p_ids) and scope = p_scope)
    <> cardinality(p_ids) then return 'stale'; end if;
  if p_action = 'archive' then
    update public.portal_inbox_thread_records
      set row_data = jsonb_set(jsonb_set(jsonb_set(row_data, '{folder}', '"trash"'),
        '{previousFolder}', to_jsonb(case when row_data->>'folder' = 'sent' then 'sent' else 'inbox' end)),
        '{unread}', 'false'), updated_at = now()
      where id = any(p_ids) and scope = p_scope and row_data->>'folder' <> 'trash';
  else
    update public.portal_inbox_thread_records
      set row_data = jsonb_set((row_data - 'previousFolder'), '{folder}',
        to_jsonb(case when row_data->>'previousFolder' = 'sent' then 'sent' else 'inbox' end)),
        updated_at = now()
      where id = any(p_ids) and scope = p_scope and row_data->>'folder' = 'trash';
  end if;
  get diagnostics changed = row_count;
  return 'ok';
end;
$$;
revoke all on function public.change_portal_inbox_thread_folders(text[],text,text) from public,anon,authenticated;
grant execute on function public.change_portal_inbox_thread_folders(text[],text,text) to service_role;

create or replace function public.change_sms_notice_folder_and_tour_followup(
  p_owner uuid, p_actor uuid, p_keys text[], p_action text, p_id uuid,
  p_text text, p_send_at timestamptz, p_access_revision text, p_allowed_properties text[],
  p_expected_tags jsonb, p_inbox_ids text[]
) returns text language plpgsql security definer set search_path = public as $$
declare result text;
begin
  if p_action not in ('archive', 'restore') or coalesce(cardinality(p_inbox_ids), 0) = 0 then return 'invalid'; end if;
  if (select count(*) from public.portal_inbox_thread_records
      where id = any(p_inbox_ids) and owner_user_id = p_owner and scope = 'axis_portal_inbox_manager_v1')
    <> cardinality(p_inbox_ids) then return 'stale'; end if;
  result := public.change_tour_interest_followup(p_owner,p_actor,p_keys,p_action,p_id,p_text,p_send_at,
    p_access_revision,p_allowed_properties,p_expected_tags);
  if result <> 'ok' then return result; end if;
  if p_action = 'archive' then
    update public.portal_inbox_thread_records
      set row_data = jsonb_set(jsonb_set(jsonb_set(row_data, '{folder}', '"trash"'),
        '{previousFolder}', to_jsonb(case when row_data->>'folder' = 'sent' then 'sent' else 'inbox' end)),
        '{unread}', 'false'), updated_at = now()
      where id = any(p_inbox_ids) and owner_user_id = p_owner and scope = 'axis_portal_inbox_manager_v1'
        and row_data->>'folder' <> 'trash';
  else
    update public.portal_inbox_thread_records
      set row_data = jsonb_set((row_data - 'previousFolder'), '{folder}',
        to_jsonb(case when row_data->>'previousFolder' = 'sent' then 'sent' else 'inbox' end)),
        updated_at = now()
      where id = any(p_inbox_ids) and owner_user_id = p_owner and scope = 'axis_portal_inbox_manager_v1'
        and row_data->>'folder' = 'trash';
  end if;
  return 'ok';
end;
$$;
revoke all on function public.change_sms_notice_folder_and_tour_followup(uuid,uuid,text[],text,uuid,text,timestamptz,text,text[],jsonb,text[]) from public,anon,authenticated;
grant execute on function public.change_sms_notice_folder_and_tour_followup(uuid,uuid,text[],text,uuid,text,timestamptz,text,text[],jsonb,text[]) to service_role;
