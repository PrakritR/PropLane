-- Vendor dispatch rules + runs (captain, Oct 18 2026). Additive.
-- "If any of houses X has a lockout, send locksmith Y, then backups D and E."
-- Every dispatch is approved by the manager before any vendor is texted
-- (approval = 'always' is the only value today). Builds on the existing
-- manager_vendor_records roster, portal_work_order_records and
-- work_order_vendor_offers; docs/agents/vendor-dispatch-agent.md.

create table if not exists public.vendor_dispatch_rules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.portal_workspaces (id) on delete cascade,
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  -- Vendor role the job needs: locksmith, plumber, cleaner, tour_host, ...
  trade text not null check (trade ~ '^[a-z_]{2,32}$'),
  -- Narrower issue inside the trade (lockout, leak, turnover, ...). Null = any job of the trade.
  issue text check (issue is null or issue ~ '^[a-z_]{2,32}$'),
  property_scope text not null default 'all' check (property_scope in ('all', 'selected')),
  property_ids text[] not null default '{}',
  urgencies text[] not null default '{emergency,urgent,routine}',
  hours text not null default 'any' check (hours in ('any', 'business', 'after_hours')),
  mode text not null default 'sequential' check (mode in ('sequential', 'broadcast')),
  broadcast_size integer not null default 3 check (broadcast_size between 2 and 10),
  -- Null = the default for the job's urgency (emergency 10, urgent 30, routine 120).
  timeout_minutes integer check (timeout_minutes is null or timeout_minutes between 2 and 1440),
  pay_cents integer check (pay_cents is null or pay_cents >= 0),
  pay_model text not null default 'flat' check (pay_model in ('flat', 'hourly', 'per_room', 'quote')),
  nte_cents integer check (nte_cents is null or nte_cents >= 0),
  -- Manager approves every dispatch before a vendor is texted. Widened later, never silently.
  approval text not null default 'always' check (approval in ('always')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists vendor_dispatch_rules_workspace_idx
  on public.vendor_dispatch_rules (workspace_id, trade, active);

-- Ordered chain: position 0 is the primary, 1.. are backups.
create table if not exists public.vendor_dispatch_rule_vendors (
  rule_id uuid not null references public.vendor_dispatch_rules (id) on delete cascade,
  vendor_directory_id text not null references public.manager_vendor_records (id) on delete cascade,
  position integer not null check (position between 0 and 19),
  primary key (rule_id, vendor_directory_id),
  unique (rule_id, position)
);

-- One dispatch of one job (a service, a tour needing a host, a cleaning turnover).
create table if not exists public.vendor_dispatch_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.portal_workspaces (id) on delete cascade,
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  -- Short handle the manager types back: "Y 7" approves run 7 when two are pending.
  handle integer not null,
  source_type text not null check (source_type in ('work_order', 'service_request', 'tour', 'cleaning', 'manual')),
  source_id text not null,
  rule_id uuid references public.vendor_dispatch_rules (id) on delete set null,
  trade text not null,
  issue text,
  urgency text not null check (urgency in ('emergency', 'urgent', 'routine')),
  property_id text references public.manager_property_records (id) on delete set null,
  -- Exactly what the vendor will read (no resident phone, first name only).
  offer_text text not null,
  pay_cents integer,
  nte_cents integer,
  mode text not null check (mode in ('sequential', 'broadcast')),
  timeout_minutes integer not null,
  status text not null default 'awaiting_approval' check (status in (
    'awaiting_approval', 'offering', 'accepted', 'exhausted', 'declined_by_manager',
    'canceled', 'completed'
  )),
  approval_channel text check (approval_channel is null or approval_channel in ('sms', 'portal')),
  approved_by uuid references auth.users (id) on delete set null,
  approved_at timestamptz,
  approval_reminded_at timestamptz,
  approval_escalated_at timestamptz,
  accepted_vendor_directory_id text references public.manager_vendor_records (id) on delete set null,
  accepted_at timestamptz,
  scheduled_for timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_user_id, handle)
);
create unique index if not exists vendor_dispatch_runs_one_open_per_source
  on public.vendor_dispatch_runs (source_type, source_id)
  where status in ('awaiting_approval', 'offering');
create index if not exists vendor_dispatch_runs_workspace_idx
  on public.vendor_dispatch_runs (workspace_id, status, created_at desc);

create table if not exists public.vendor_dispatch_attempts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.vendor_dispatch_runs (id) on delete cascade,
  vendor_directory_id text not null references public.manager_vendor_records (id) on delete cascade,
  position integer not null,
  wave integer not null default 0,
  status text not null default 'queued' check (status in (
    'queued', 'offered', 'accepted', 'declined', 'busy', 'timed_out', 'superseded', 'canceled'
  )),
  offered_at timestamptz,
  timeout_at timestamptz,
  responded_at timestamptz,
  response_text text,
  busy_until timestamptz,
  proposed_time text,
  outbox_id uuid,
  created_at timestamptz not null default now(),
  unique (run_id, vendor_directory_id)
);
create index if not exists vendor_dispatch_attempts_due_idx
  on public.vendor_dispatch_attempts (status, timeout_at) where status = 'offered';

-- Per-owner run handle counter (small integers the manager can type).
create table if not exists public.vendor_dispatch_handle_counters (
  owner_user_id uuid primary key references auth.users (id) on delete cascade,
  last_handle integer not null default 0
);

create or replace function public.next_vendor_dispatch_handle(p_owner uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v integer;
begin
  insert into public.vendor_dispatch_handle_counters (owner_user_id, last_handle)
  values (p_owner, 1)
  on conflict (owner_user_id) do update
    set last_handle = public.vendor_dispatch_handle_counters.last_handle + 1
  returning last_handle into v;
  return v;
end;
$$;
revoke all on function public.next_vendor_dispatch_handle(uuid) from public, anon, authenticated;
grant execute on function public.next_vendor_dispatch_handle(uuid) to service_role;

do $$
declare
  t text;
begin
  foreach t in array array[
    'vendor_dispatch_rules', 'vendor_dispatch_rule_vendors', 'vendor_dispatch_runs',
    'vendor_dispatch_attempts', 'vendor_dispatch_handle_counters'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;
