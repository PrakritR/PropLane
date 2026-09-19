-- Public listing reads must use the server-side allowlisted projection.
-- The test-workspace migration accidentally recreated this raw-table policy
-- after it had been removed by 20260809120000.
drop policy if exists "manager_property_records_select_live"
  on public.manager_property_records;
