-- Co-manager grants become EXPLICIT: an empty permissions map now means NO access.
--
-- It used to mean "no restrictions" — every module at every level, including
-- delete on leases, financials and documents. That default failed open and was
-- reachable without the manager ever opening the permissions editor (checking a
-- property seeded `{}`), and also by the opposite gesture: turning every level
-- off deleted every module key, which also produced `{}`, so restricting a
-- co-manager to nothing granted them everything.
--
-- The application now reads an empty map as least privilege. This backfill
-- preserves what existing links were actually conferring: a per-property entry
-- still relying on the old sentinel is rewritten to state that grant
-- explicitly, so no live co-manager loses access when the code ships. Entries
-- that already enumerate modules are left exactly as they are.
--
-- Idempotent: a row rewritten once no longer has an empty per-property entry,
-- so a replay (Supabase records migrations under apply-time versions and
-- `db push --include-all` replays them) changes nothing.

do $$
declare
  full_grant constant jsonb := jsonb_build_object(
    'properties', true,
    'applications', true,
    'residents', true,
    'leases', true,
    'payments', true,
    'documents', true,
    'financials', true,
    'services', true,
    'promotion', true,
    'inbox', true,
    'calendar', true
  );
  r record;
  next_perms jsonb;
  prop_id text;
  existing jsonb;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'account_link_invites'
      and column_name = 'property_co_manager_permissions'
  ) then
    return;
  end if;

  for r in
    select id, assigned_property_ids, property_co_manager_permissions
    from public.account_link_invites
  loop
    next_perms := coalesce(r.property_co_manager_permissions, '{}'::jsonb);
    for prop_id in
      select jsonb_array_elements_text(coalesce(r.assigned_property_ids, '[]'::jsonb))
    loop
      existing := coalesce(next_perms -> prop_id, '{}'::jsonb);
      -- Keep an enumerated grant untouched; only the old empty sentinel is rewritten.
      if existing = '{}'::jsonb then
        next_perms := next_perms || jsonb_build_object(prop_id, full_grant);
      end if;
    end loop;

    if next_perms is distinct from coalesce(r.property_co_manager_permissions, '{}'::jsonb) then
      update public.account_link_invites
      set property_co_manager_permissions = next_perms
      where id = r.id;
    end if;
  end loop;
end $$;

comment on column public.account_link_invites.property_co_manager_permissions is
  'Per-property co-manager module grants. An absent or empty entry confers NO access — '
  'access must be enumerated. Full access is stored explicitly as every module true.';
