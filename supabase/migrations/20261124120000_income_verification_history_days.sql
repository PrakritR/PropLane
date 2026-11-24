-- How much bank history the applicant income figure was drawn from.
--
-- The figure is an average of the payroll deposits of the last 90 days divided by those 3 months, so a 45-day-old
-- account reads as a full quarter of pay unless the manager is told otherwise. Nullable: a row stored before this
-- column shows the figure without the note, never a guessed history.
alter table public.applicant_income_verifications
  add column if not exists history_days smallint check (history_days is null or history_days between 0 and 90);
