-- night/vendor-pay follow-up fix.
--
-- A double-entry move's two rows live on DIFFERENT accounts
-- (`proplane_balance_move`: a workspace debit crossed with a vendor credit,
-- or vice versa) and cross-reference each other via `related_entry_id`.
-- Without `on delete set null`, deleting only ONE side's account (an account
-- purge that reaches the vendor's account before the manager's, or any
-- future cleanup that removes one account independently) fails outright:
-- the surviving entry's `related_entry_id` still points at a row the
-- cascade just tried to remove, and Postgres refuses the whole delete.
--
-- Found live: cleaning up paired night-vendor-pay-followup proof fixtures
-- (a workspace debit + the matching vendor credit) by deleting only the
-- workspace's account hit exactly this violation. `on delete set null`
-- keeps the surviving entry's own facts (amount, kind, status) intact and
-- just drops the now-dangling cross-reference — the ledger is still a
-- correct mirror of what actually happened, it just loses the "this entry's
-- pair" pointer once that pair is gone.
alter table public.proplane_balance_entries
  drop constraint if exists proplane_balance_entries_related_entry_id_fkey;
alter table public.proplane_balance_entries
  add constraint proplane_balance_entries_related_entry_id_fkey
  foreign key (related_entry_id) references public.proplane_balance_entries(id) on delete set null;
