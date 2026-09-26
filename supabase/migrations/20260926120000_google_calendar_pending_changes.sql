-- Two-way Google Calendar sync: "attention items" for a PropLane-authored
-- event (a confirmed tour or a service visit) that was edited or deleted on
-- Google since PropLane last pushed it. Written by
-- `pullProplaneCalendarPendingChanges`
-- (src/lib/google-calendar/proplane-calendar-reconcile.server.ts), which
-- never applies a Google-side time change or cancellation automatically —
-- a manager or vendor explicitly accepts or dismisses each row from the
-- Calendar page. Additive and idempotent; NOT applied by this change.

create table if not exists public.google_calendar_pending_changes (
  id text primary key,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  owner_kind text not null check (owner_kind in ('manager', 'vendor')),
  record_kind text not null check (record_kind in ('tour', 'work_order')),
  record_id text not null,
  google_calendar_event_id text not null,
  change_type text not null check (change_type in ('time_changed', 'deleted')),
  summary text,
  previous_start timestamptz,
  previous_end timestamptz,
  proposed_start timestamptz,
  proposed_end timestamptz,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'dismissed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists google_calendar_pending_changes_owner_status_idx
  on public.google_calendar_pending_changes (owner_user_id, status);

-- Same recipe as prospect_tour_google_calendar_cleanup and
-- manager_automation_settings: RLS on with zero policies default-denies
-- anon/authenticated via PostgREST while service-role (the only caller —
-- every read/write above goes through the service-role client) is
-- unaffected.
alter table public.google_calendar_pending_changes enable row level security;

revoke all on public.google_calendar_pending_changes from anon, authenticated, public;
grant select, insert, update, delete on public.google_calendar_pending_changes to service_role;
