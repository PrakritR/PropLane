-- Widen the action-event bus to the cross-party domains that had no coverage.
--
-- The bus already carried work orders, payments and leases end to end, with one
-- idempotent fact fanning out to a manager/resident/vendor projection each. The
-- lifecycle moments a person actually waits on outside those three -- an
-- application filed, approved or declined; an add-on service requested,
-- scheduled or completed; a tour requested, confirmed or cancelled -- were
-- notified ad hoc if at all, so one side routinely learned nothing.
--
-- `voice_calls` is added to the category list at the same time. It is already a
-- valid `NotificationCategory` in the application, so an event emitted under it
-- would have been rejected by this constraint at insert time.
--
-- Idempotent: constraints are dropped by name before being recreated, so a
-- replay under `db push --include-all` is a no-op.

alter table public.action_events
  drop constraint if exists action_events_domain_check,
  add constraint action_events_domain_check
    check (domain in ('work_order', 'payment', 'lease', 'application', 'service_request', 'tour')),
  drop constraint if exists action_events_category_check,
  add constraint action_events_category_check
    check (category in ('messages', 'leases', 'payments', 'maintenance', 'applications', 'voice_calls', 'account'));

comment on table public.action_events is
  'Canonical idempotent cross-party facts: work orders, payments, leases, applications, add-on service requests, and tours. Service-role writers only.';
