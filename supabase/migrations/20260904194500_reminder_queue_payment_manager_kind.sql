-- Add payment_manager kind for manager-facing unpaid-rent alerts.

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
      'payment_manager',
      'outgoing_payment'
    )
  );
