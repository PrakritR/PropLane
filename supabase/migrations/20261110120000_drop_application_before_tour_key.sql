-- The "Application before a tour" workspace setting is removed (captain, Nov 10 2026): anyone signed in
-- can request a tour. The app already ignores the stored key (the normalizer drops it); this strips the
-- dead `applicationBeforeTour` value from the workspace row and from every per-property override.
-- Idempotent: a row without the key is not matched, so a second run changes nothing.

update public.manager_automation_settings
set row_data = jsonb_set(
  row_data,
  '{leasingPipeline}',
  (row_data -> 'leasingPipeline') - 'applicationBeforeTour'
)
where jsonb_typeof(row_data -> 'leasingPipeline') = 'object'
  and jsonb_exists(row_data -> 'leasingPipeline', 'applicationBeforeTour');

update public.manager_automation_settings s
set row_data = jsonb_set(
  s.row_data,
  '{leasingPipelineByPropertyId}',
  coalesce(
    (
      select jsonb_object_agg(
        e.key,
        case when jsonb_typeof(e.value) = 'object' then e.value - 'applicationBeforeTour' else e.value end
      )
      from jsonb_each(s.row_data -> 'leasingPipelineByPropertyId') as e
    ),
    '{}'::jsonb
  )
)
where jsonb_typeof(s.row_data -> 'leasingPipelineByPropertyId') = 'object'
  and exists (
    select 1
    from jsonb_each(s.row_data -> 'leasingPipelineByPropertyId') as e
    where jsonb_typeof(e.value) = 'object' and jsonb_exists(e.value, 'applicationBeforeTour')
  );
