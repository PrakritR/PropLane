-- Human-readable assistant mailbox local parts (assist-jane-smith@domain).
alter table public.manager_assistant_emails
  add column if not exists mailbox_local text;

create unique index if not exists manager_assistant_emails_mailbox_local_uniq
  on public.manager_assistant_emails (mailbox_local)
  where provision_state = 'active' and mailbox_local is not null;
