-- Each provider refund is a separate immutable cash movement, including partial refunds.
alter table public.ledger_entries add column if not exists stripe_refund_id text;
-- Adopt the last persisted legacy refund's journal identity before redelivery can duplicate it.
update public.ledger_entries l
set stripe_refund_id = substring(j.source_id from length('refund:' || l.source_charge_id || ':') + 1)
from public.gl_journal_entries j
where l.entry_type = 'refund' and l.stripe_refund_id is null
  and l.gl_journal_entry_id = j.id and j.source_type = 'refund'
  and starts_with(j.source_id, 'refund:' || l.source_charge_id || ':');
create unique index if not exists ledger_entries_provider_refund_unique
  on public.ledger_entries (source_charge_id, entry_type, stripe_refund_id);
-- Preserve original charge/payment and legacy refund identity while allowing tagged refunds.
drop index if exists public.ledger_entries_charge_type_unique;
create unique index if not exists ledger_entries_charge_type_unique
  on public.ledger_entries (source_charge_id, entry_type)
  where source_charge_id is not null and stripe_refund_id is null;
