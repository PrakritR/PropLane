-- Every "after" reminder was unqueueable.
--
-- `reminderSendTimes` encodes a directional timing as a signed lead:
-- `direction === "before" ? minutes : -minutes` (src/lib/reminders/rules.ts).
-- The previous constraint accepted `between 5 and 43200` — positive only —
-- with a single hardcoded carve-out for `tour_interest` at exactly -1440.
--
-- Eleven of the fifteen kinds default to at least one `after:` timing, so
-- chasing an incomplete application, an unsigned lease, an overdue payment,
-- a missing condition report or a post-tour apply link all failed on a 23514
-- check violation at insert. The sweep logged it and moved on, so the queue
-- simply stayed empty and no reminder was ever sent.
--
-- The magnitude bounds were always the real rule (5 minutes to 30 days); the
-- sign carries direction and is not a validity question. Allow both, and drop
-- the coupling to `kind` so adding a kind never has to think about this again.
-- Deliberately a different constraint from `portal_reminder_records_kind_check`,
-- which is being widened separately.

alter table public.portal_reminder_records
  drop constraint if exists portal_reminder_records_lead_check;

alter table public.portal_reminder_records
  add constraint portal_reminder_records_lead_check
  check (abs(lead_minutes) between 5 and 43200);
