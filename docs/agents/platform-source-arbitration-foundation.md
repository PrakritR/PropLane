# Platform source arbitration foundation

`20261004221000_platform_hold_source_arbitration.sql` adds source provenance,
refund evidence, and transfer/refund reservation routines. It depends on the
existing platform holds and vendor banking schema (`20260927180000`), not on
the unreviewed vendor checkout claim migration (`20261004220000`). The new
routines are service-role only. No existing hold status or amount is rewritten;
unverified historical holds remain visible but cannot enter the new release or
refund routines without exact provider evidence.

This is an **inert foundation**, not authorization to route payments through
the new helpers. Existing checkout, webhook, refund, wallet, and withdrawal
writers retain their previous behavior until a reviewed runtime migration
binds each captured source and component. Do not infer source principal, refund
history, or recipient net from a legacy hold's remaining amount. Before
activation, every writer must use the same source reservations; in particular,
mixed rent/deposit components need classified wallet mirroring and atomic
spend/release arbitration, and manager-fee refund deficits need actual provider
creditor evidence, balanced accounting, and same-owner income recovery.

Local proof applies the migration twice to disposable PostgreSQL and exercises
source alias races, refund/transfer reservations, service-only grants, and
legacy insert/update compatibility. A dev or production apply requires the
normal reviewed migration gate; this file alone authorizes no data repair,
transfer, refund, or rollout.
