-- Work-order rows contain a resident Auth subject in a column and JSON mirror.
-- The vendor portal reads its scoped, redacted projection through server routes.
drop policy if exists portal_work_order_records_vendor_read on public.portal_work_order_records;
