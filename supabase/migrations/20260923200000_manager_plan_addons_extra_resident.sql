-- Allow extra_resident on manager_plan_addons (monthly residents add-on).
-- Do not add extra_comms_credit — communication credit is Extra usage only.
alter table public.manager_plan_addons
  drop constraint if exists manager_plan_addons_addon_id_check;

alter table public.manager_plan_addons
  add constraint manager_plan_addons_addon_id_check
  check (addon_id in (
    'extra_listing',
    'extra_work_number',
    'extra_workspace',
    'extra_seat',
    'extra_resident'
  ));
