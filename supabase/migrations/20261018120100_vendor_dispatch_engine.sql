-- Vendor dispatch engine (captain, Oct 18 2026). Additive + idempotent.
-- Builds on 20261018120000_vendor_dispatch_rules.sql: the run needs the job's
-- details (server-only, for the post-accept confirmation text), the manager's
-- approval fan-out state, the vendor-done / resident-confirm state, and a
-- price-over-cap hold on an attempt. Also admits the `vendor_dispatch` domain
-- on action_events so every approve / decline / accept is audited there.

alter table public.vendor_dispatch_runs
  add column if not exists details jsonb not null default '{}'::jsonb,
  add column if not exists resident_email text,
  add column if not exists deadline_at timestamptz,
  add column if not exists approval_notified_user_ids uuid[] not null default '{}',
  add column if not exists agreed_cents integer,
  add column if not exists wave integer not null default 0,
  add column if not exists exhausted_at timestamptz,
  add column if not exists vendor_done_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists completion_state text,
  add column if not exists pending_invoice_cents integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'vendor_dispatch_runs_completion_state_check'
      and conrelid = 'public.vendor_dispatch_runs'::regclass
  ) then
    alter table public.vendor_dispatch_runs
      add constraint vendor_dispatch_runs_completion_state_check
      check (completion_state is null or completion_state in ('awaiting_resident', 'confirmed', 'reopened'));
  end if;
end $$;

alter table public.vendor_dispatch_attempts
  add column if not exists quote_cents integer,
  add column if not exists quote_status text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'vendor_dispatch_attempts_quote_status_check'
      and conrelid = 'public.vendor_dispatch_attempts'::regclass
  ) then
    alter table public.vendor_dispatch_attempts
      add constraint vendor_dispatch_attempts_quote_status_check
      check (quote_status is null or quote_status in ('pending', 'approved', 'rejected'));
  end if;
end $$;

create index if not exists vendor_dispatch_attempts_vendor_idx
  on public.vendor_dispatch_attempts (vendor_directory_id, status);
create index if not exists vendor_dispatch_runs_source_idx
  on public.vendor_dispatch_runs (source_type, source_id, created_at desc);

-- Widen action_events.domain by READING the live constraint, so a peer migration
-- that added its own domains is never rolled back by this one.
do $$
declare
  def text;
  vals text[];
begin
  select pg_get_constraintdef(c.oid) into def
  from pg_constraint c
  where c.conname = 'action_events_domain_check'
    and c.conrelid = 'public.action_events'::regclass;
  if def is null then
    return;
  end if;
  select coalesce(array_agg(distinct m[1]), '{}') into vals
  from regexp_matches(def, '''([a-z_]+)''', 'g') as m;
  if 'vendor_dispatch' = any (vals) then
    return;
  end if;
  vals := array_append(vals, 'vendor_dispatch');
  execute 'alter table public.action_events drop constraint if exists action_events_domain_check';
  execute format(
    'alter table public.action_events add constraint action_events_domain_check check (domain in (%s))',
    (select string_agg(quote_literal(v), ', ' order by v) from unnest(vals) as v)
  );
end $$;
