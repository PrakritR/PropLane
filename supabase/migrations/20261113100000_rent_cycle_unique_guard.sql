-- One live rent charge per tenant + property + billing month, enforced in the database.
--
-- The recurring sweep (and a manager typing a manual Dec rent charge) used to dedupe in application code only,
-- so a manual charge and the automatic cycle could both land for the same month. This is the DB-level guard.
--
--  * Only rows created on/after the cutoff are indexed, so rent charges that already exist (and may already be
--    duplicated) never make the index fail to build; they are reported by the DO block below instead.
--  * void / cancelled / refunded rows are excluded: a voided or waived duplicate frees the slot.
--  * Imported (migrationSourceId) rows are excluded: an import writes its own all-in rows.
--  * The room is deliberately NOT part of the database key: a tenant is in one room of a property per month, and
--    manual charges carry no room. The application key (`chargeBusinessKey`) does include it.
-- Additive and idempotent. No row is changed or deleted.

do $$
declare
  dup_count integer;
begin
  select count(*) into dup_count from (
    select 1
    from public.portal_household_charge_records
    where kind = 'rent'
      and coalesce(row_data->>'rentMonth', '') <> ''
      and status not in ('void', 'cancelled', 'refunded')
      and coalesce(row_data->>'migrationSourceId', '') = ''
    group by manager_user_id, lower(resident_email), property_id, row_data->>'rentMonth'
    having count(*) > 1
  ) d;
  raise notice 'rent_cycle_unique_guard: % existing duplicate rent cycle(s) left untouched (not indexed).', dup_count;
end $$;

create unique index if not exists portal_household_charge_rent_cycle_unique
  on public.portal_household_charge_records (
    manager_user_id,
    lower(resident_email),
    property_id,
    (row_data->>'rentMonth')
  )
  where kind = 'rent'
    and coalesce(row_data->>'rentMonth', '') <> ''
    and status not in ('void', 'cancelled', 'refunded')
    and coalesce(row_data->>'migrationSourceId', '') = ''
    and created_at >= timestamptz '2026-11-14 00:00:00+00';
