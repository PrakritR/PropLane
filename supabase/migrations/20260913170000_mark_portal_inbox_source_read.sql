begin;

create or replace function public.mark_portal_inbox_source_read(
  p_id text, p_scope text, p_owner_user_id uuid, p_participant_email text,
  p_thread_type text, p_updated_at timestamptz, p_row_data jsonb
) returns boolean
language sql volatile security invoker set search_path = '' as $$
  with changed as (
    update public.portal_inbox_thread_records
    set row_data = pg_catalog.jsonb_set(row_data, '{unread}', 'false'::jsonb, true),
        updated_at = greatest(pg_catalog.clock_timestamp(), updated_at + interval '1 microsecond')
    where p_id <> '' and id = p_id and scope = 'axis_portal_inbox_manager_v1' and scope = p_scope
      and p_owner_user_id is not null and owner_user_id = p_owner_user_id
      and participant_email is not distinct from p_participant_email
      and thread_type is not distinct from p_thread_type
      and p_updated_at is not null and updated_at = p_updated_at
      and pg_catalog.jsonb_typeof(p_row_data) = 'object' and row_data = p_row_data
      and row_data->'folder' in ('"inbox"'::jsonb, '"sent"'::jsonb)
      and row_data->'unread' = 'true'::jsonb
    returning id
  ) select exists(select 1 from changed);
$$;
revoke all on function public.mark_portal_inbox_source_read(text,text,uuid,text,text,timestamptz,jsonb) from public, anon, authenticated;
grant execute on function public.mark_portal_inbox_source_read(text,text,uuid,text,text,timestamptz,jsonb) to service_role;
commit;
