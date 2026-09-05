-- Expand reminder queue kinds for split application/lease rules and post-tour follow-ups.
-- Also allow team recipient_role (already written by materializeReminders).

alter table public.portal_reminder_records
  drop constraint if exists portal_reminder_records_kind_check;

alter table public.portal_reminder_records
  add constraint portal_reminder_records_kind_check
  check (
    kind in (
      'tour',
      'task',
      'service_order',
      'work_order',
      'booking',
      'application',
      'application_manager',
      'application_post_tour',
      'lease',
      'lease_manager',
      'outgoing_payment'
    )
  );

alter table public.portal_reminder_records
  drop constraint if exists portal_reminder_records_role_check;

alter table public.portal_reminder_records
  add constraint portal_reminder_records_role_check
  check (recipient_role in ('manager', 'counterparty', 'team'));
