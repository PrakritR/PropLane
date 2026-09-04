-- Generalize the PRP-262 work-order outbox into the canonical action-event bus.
-- Renames preserve any events already written between the two deployments.
do $$
begin
  if to_regclass('public.work_order_events') is not null
     and to_regclass('public.action_events') is null then
    alter table public.work_order_events rename to action_events;
  end if;
  if to_regclass('public.work_order_event_deliveries') is not null
     and to_regclass('public.action_event_deliveries') is null then
    alter table public.work_order_event_deliveries rename to action_event_deliveries;
  end if;
end $$;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'action_events' and column_name = 'work_order_id'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'action_events' and column_name = 'entity_id'
  ) then
    alter table public.action_events rename column work_order_id to entity_id;
  end if;
end $$;

alter table public.action_events
  drop constraint if exists work_order_events_event_type_check;
alter table public.action_events
  add column if not exists domain text not null default 'work_order',
  add column if not exists category text not null default 'maintenance',
  add column if not exists sender_user_id uuid references auth.users(id) on delete set null,
  add column if not exists sender_email text,
  add column if not exists sender_name text;

-- Events written by the immediately preceding work-order migration did not
-- persist sender identity. Use the owning manager as the safe retry sender.
update public.action_events event
set sender_user_id = event.manager_user_id,
    sender_email = profile.email
from public.profiles profile
where event.sender_user_id is null
  and event.manager_user_id = profile.id;

alter table public.action_events
  drop constraint if exists action_events_domain_check,
  add constraint action_events_domain_check check (domain in ('work_order', 'payment', 'lease')),
  drop constraint if exists action_events_category_check,
  add constraint action_events_category_check check (category in ('messages', 'leases', 'payments', 'maintenance', 'applications', 'account'));

create index if not exists action_events_entity_idx
  on public.action_events (manager_user_id, domain, entity_id, occurred_at desc);

comment on table public.action_events is
  'Canonical idempotent work-order, payment, and lease facts. Service-role writers only.';
comment on table public.action_event_deliveries is
  'Idempotent and retryable per-recipient consumers of canonical action events.';
