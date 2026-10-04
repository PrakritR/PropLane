-- The public iCal export narrows the approved-application read to one property in the database
-- (`/api/calendar/export/[token]`), always scoped by `manager_user_id` first. The existing
-- `(assigned_property_id, updated_at desc)` index does not serve that pair, so a channel polling a
-- room paid a scan bounded only by the manager's approved-application history.
--
-- Additive and idempotent: index only, no grant, policy or column change. Guarded on the column so
-- replaying this against a database that predates `assigned_property_id` is a no-op.
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'manager_application_records'
      and column_name = 'assigned_property_id'
  ) then
    create index if not exists manager_application_records_manager_assigned_property_idx
      on public.manager_application_records (manager_user_id, assigned_property_id);
  end if;
end
$$;

create index if not exists manager_application_records_manager_property_idx
  on public.manager_application_records (manager_user_id, property_id);
