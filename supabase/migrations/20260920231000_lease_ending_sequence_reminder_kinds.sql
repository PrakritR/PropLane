-- PLAN-0915 area 4: the lease-ending sequence.
--
-- Three new reminder kinds, additive and idempotent, widening the existing
-- `portal_reminder_records` kind check (see
-- `supabase/migrations/20260915120000_automated_communication_reminder_kinds.sql`):
--
--   lease_renewal_offer   — 60 days before the lease ends, resident
--   move_out_instructions — 14 days before an explicit move-out date, resident
--   deposit_return_notice — the day of move-out, resident
--
-- All three are informational: they tell a resident what is coming and where
-- to go for it, never a regulated notice — deposit accounting itself stays
-- the existing manager-only `deposit_accounting` kind.

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
      'lease_renewal_offer','move_out_instructions','deposit_return_notice',
      'application_documents','application_decision_manager','application_no_lease_manager','cosigner','group_application',
      'tour_request_unanswered','tour_request_reoffer','tour_no_show_manager','tour_feedback',
      'delinquency_manager','message_unanswered','document_signature','task_overdue','resident_welcome','inspection_acknowledge'
    )
  );
