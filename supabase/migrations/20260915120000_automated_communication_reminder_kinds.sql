-- PLAN-0915: automated communication across every portal.
--
-- Three widenings on the reminder queue, all additive and idempotent:
--
-- 1. `kind` — 33 new subject kinds (escalations, the vendor loop, lease ending,
--    move-in/move-out, applications, tours, payments, communication, documents,
--    tasks, residents, inspections). Declared in `REMINDER_SUBJECT_KINDS`
--    (src/lib/reminders/rules.ts); the check keeps the table honest but must
--    list every kind the code can queue.
-- 2. `recipient_role` — a vendor is now an audience in its own right. Before
--    this the dispatched vendor rode with the `team` role, which delivers
--    through the manager's Assistant surface and never actually reached the
--    vendor.
-- 3. `lead_minutes` — the magnitude ceiling rises from 30 to 90 days so a
--    lease-ending notice can fire 90 and 60 days out. Matches
--    `MAX_TIMING_MINUTES` in src/lib/reminders/timings.ts.

alter table public.portal_reminder_records
  drop constraint if exists portal_reminder_records_kind_check;

alter table public.portal_reminder_records
  add constraint portal_reminder_records_kind_check
  check (
    kind in (
      'tour','tour_interest','task','service_order','work_order','booking','application','application_manager',
      'application_post_tour','lease','lease_manager','payment_manager','outgoing_payment','inspection','inspection_manager',
      'work_order_unassigned','work_order_unassigned_emergency','work_order_no_on_my_way','vendor_offer_expiry',
      'vendor_invoice_nudge','invoice_approval','service_request_decision','service_request_unpaid','vendor_document_expiry',
      'lease_ending','lease_ending_manager','renewal_offer_expiry','countersign_overdue','move_in','move_in_payment_method',
      'move_out','move_out_inspection_manager','deposit_accounting',
      'application_documents','application_decision_manager','application_no_lease_manager','cosigner','group_application',
      'tour_request_unanswered','tour_request_reoffer','tour_no_show_manager','tour_feedback',
      'delinquency_manager','message_unanswered','document_signature','task_overdue','resident_welcome','inspection_acknowledge'
    )
  );

alter table public.portal_reminder_records
  drop constraint if exists portal_reminder_records_role_check;

alter table public.portal_reminder_records
  add constraint portal_reminder_records_role_check
  check (recipient_role in ('manager', 'counterparty', 'team', 'vendor'));

alter table public.portal_reminder_records
  drop constraint if exists portal_reminder_records_lead_check;

alter table public.portal_reminder_records
  add constraint portal_reminder_records_lead_check
  check (abs(lead_minutes) between 5 and 129600);

-- Vendor offers now expire. `expires_at` is stamped at send from the manager's
-- Services setting; the dispatcher's expiry sweep flips unanswered offers to
-- 'expired' and tells both sides. Still read-only for clients at the database
-- layer, exactly as the decline column is.
alter table public.work_order_vendor_offers
  drop constraint if exists work_order_vendor_offers_status_check;

alter table public.work_order_vendor_offers
  add constraint work_order_vendor_offers_status_check
  check (status in ('sent', 'withdrawn', 'declined', 'expired', 'filled'));

alter table public.work_order_vendor_offers
  add column if not exists expires_at timestamptz;

create index if not exists work_order_vendor_offers_expires_idx
  on public.work_order_vendor_offers (expires_at)
  where status = 'sent';
