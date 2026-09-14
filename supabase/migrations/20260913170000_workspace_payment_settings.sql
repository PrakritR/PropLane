-- Payment setup is answered once per WORKSPACE, not per property.
--
-- Payment setup used to ask which PROPERTIES a processing-fee choice applied
-- to, so a manager could pick three of nine houses and leave the other six on
-- whatever they had, with nothing on screen saying so. The choice now belongs
-- to the workspace the houses are already grouped into
-- (`manager_property_records.workspace_id`, added with the workspaces table).
--
-- A single house may still be given its own answer above this; the resolver
-- order is staff override -> the house -> its workspace -> the account.
--
-- Client roles get SELECT only, as with every other trust-signal table here:
-- writes go through the service-role settings route, which re-derives ownership
-- and never trusts an id from the request body.

alter table public.portal_workspaces
  add column if not exists payment_settings jsonb;

comment on column public.portal_workspaces.payment_settings is
  'Payment setup for this workspace. serviceFeePayer: resident|manager|proplane; '
  'serviceFeeWaiverCode is the processing coverage code that backs a proplane choice. '
  'Null means the workspace follows the account-wide default.';

-- Backfill: every account''s existing account-wide choice lands on its own
-- default workspace, which is exactly where it already applied. No live account
-- has a second workspace, so nothing moves scope and no manager sees a change.
update public.portal_workspaces w
set payment_settings = jsonb_strip_nulls(
  jsonb_build_object(
    'serviceFeePayer', nullif(s.manual_payments ->> 'serviceFeePayer', ''),
    'serviceFeeWaiverCode', nullif(s.manual_payments ->> 'serviceFeeWaiverCode', '')
  )
)
from public.manager_automation_settings s
where w.is_default
  and w.payment_settings is null
  and s.manager_user_id = w.owner_user_id
  and s.manual_payments is not null
  and coalesce(s.manual_payments ->> 'serviceFeePayer', '') <> '';
