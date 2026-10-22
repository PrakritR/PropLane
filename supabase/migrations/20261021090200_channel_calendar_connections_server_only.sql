-- external_calendar_connections is server-only. It holds the import URL (a secret) and the export token, and the
-- cron sync writes room blocks onto `property_id`, so a client that could INSERT / UPDATE a row could point its
-- own iCal at ANOTHER landlord's property (RLS constrains the row's manager_user_id, never which property it names).
-- Every write already goes through the /api/portal/channel-calendar/* routes with the service-role client, which
-- re-check Calendar-at-edit on the property. Clients keep SELECT of their own rows. Idempotent.

revoke insert, update, delete on public.external_calendar_connections from anon, authenticated;

drop policy if exists "external_calendar_connections_owner" on public.external_calendar_connections;
drop policy if exists "external_calendar_connections_owner_select" on public.external_calendar_connections;
create policy "external_calendar_connections_owner_select"
  on public.external_calendar_connections
  for select
  to authenticated
  using (auth.uid() = manager_user_id);
