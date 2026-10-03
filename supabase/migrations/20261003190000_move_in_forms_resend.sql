-- Move-in forms: "Send again" on a submitted form, and automatic reminders.
--
-- 1. Only a SENT copy blocks another send. A submitted form stays on the record as history and
--    the manager may send the form again as a fresh copy. (Automatic dispatch checks for ANY
--    non-cancelled copy itself, so it never re-sends a form the resident already finished.)
-- 2. `reminders_sent` records which automatic reminders ("before", "due") already went out for a
--    row, so a re-run of the reminder sweep never double-sends.
drop index if exists public.resident_move_in_forms_open_idx;
create unique index if not exists resident_move_in_forms_open_idx
  on public.resident_move_in_forms(application_id, form_id) where status = 'sent';

alter table public.resident_move_in_forms
  add column if not exists reminders_sent jsonb not null default '{}'::jsonb;

create index if not exists resident_move_in_forms_due_idx
  on public.resident_move_in_forms(due_at) where status = 'sent';
