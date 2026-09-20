-- Later-schema tables were absent from the DEV catalog frozen into
-- 20260919123000, but are present in staging and production. Preserve that
-- applied migration byte-for-byte and extend its restrictive classified-user
-- boundary forward. Each table is optional here so environments can apply
-- this migration before or after their older additive table migration.

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'agent_user_preferences',
    'webhook_subscriptions',
    'webhook_deliveries'
  ]
  loop
    if to_regclass(format('public.%I', table_name)) is null then
      continue;
    end if;

    execute format('alter table public.%I enable row level security', table_name);
    execute format('drop policy if exists test_workspace_classified_direct_deny on public.%I', table_name);
    execute format(
      'create policy test_workspace_classified_direct_deny on public.%I as restrictive for all to authenticated using (not (select public.is_classified_test_workspace_principal())) with check (not (select public.is_classified_test_workspace_principal()))',
      table_name
    );
  end loop;
end;
$$;
