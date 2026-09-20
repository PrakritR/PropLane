-- Record-linked communication (PLAN-0920-1058, area 1b): a thread's
-- row_data can carry a `recordRef: { kind, id, label }` stamped by the send
-- path when composed from inside a record's Communication section. This
-- index is what makes "list every thread about this record" (a property, a
-- charge, a lease, ...) a cheap lookup instead of a full scan of every
-- inbox row. Additive and idempotent — safe to re-run.
create index if not exists portal_inbox_thread_records_record_ref_idx
  on public.portal_inbox_thread_records (
    (row_data -> 'recordRef' ->> 'kind'),
    (row_data -> 'recordRef' ->> 'id')
  );
