-- Admin Health reads the household-source reviews that still need a person: `audit_log` filtered on
-- `action = 'household_source_review'` plus a `created_at` window, on every Health load and in
-- parallel with four sibling reads. The table only had `(landlord_id, created_at desc)` and a partial
-- `(test_workspace_id, created_at desc)`, so that filter had no usable index and scanned a table that
-- grows with every agent tool call and every write-tool audit row.
--
-- Partial, so it indexes only the handful of rows the page actually asks for rather than every action
-- in the table. Additive and idempotent; it changes no row, no grant and no constraint.
create index if not exists audit_log_household_source_review_idx
  on public.audit_log (created_at desc)
  where action = 'household_source_review';
