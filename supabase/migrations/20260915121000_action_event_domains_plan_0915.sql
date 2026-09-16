-- PLAN-0915 phases 2–4: the action-event bus gains the inspection, task and
-- message domains (resident photo submissions, task assignment/completion,
-- after-hours acknowledgements and emergency flags). Idempotent.
alter table public.action_events
  drop constraint if exists action_events_domain_check;
alter table public.action_events
  add constraint action_events_domain_check
    check (domain in ('work_order', 'payment', 'lease', 'application', 'service_request', 'tour', 'inspection', 'task', 'message'));
