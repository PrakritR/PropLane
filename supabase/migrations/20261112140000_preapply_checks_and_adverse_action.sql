-- Pre-application requirements (Verify ID / background check before the application form opens) and the FCRA
-- adverse-action trail. Additive and idempotent. Both tables are service-role only: RLS is on with no policy, so
-- the public PostgREST surface reads and writes neither (an applicant's check state and a manager's adverse-action
-- decision are never a client-writable column).

-- One row per (signed-in applicant, listing): the Checkr order an applicant placed BEFORE applying. Once the
-- application is submitted the check is stamped onto the application row and `application_id` is filled in.
create table if not exists public.applicant_preapply_checks (
  id uuid primary key default gen_random_uuid(),
  resident_user_id uuid not null references auth.users (id) on delete cascade,
  property_id text not null,
  manager_user_id uuid references auth.users (id) on delete set null,
  application_id text,
  -- The Checkr order and report state (ApplicationBackgroundCheck): ids, package, status, per-product status. No ID
  -- image, document number or SSN is ever stored here.
  check_data jsonb not null,
  -- The applicant's FCRA authorization (disclosure version + timestamp), also kept inside check_data.
  authorized_at timestamptz,
  disclosure_version text,
  stripe_checkout_session_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists applicant_preapply_checks_user_property_idx
  on public.applicant_preapply_checks (resident_user_id, property_id);

create unique index if not exists applicant_preapply_checks_session_idx
  on public.applicant_preapply_checks (stripe_checkout_session_id)
  where stripe_checkout_session_id is not null;

create index if not exists applicant_preapply_checks_order_idx
  on public.applicant_preapply_checks ((check_data ->> 'reportId'));

alter table public.applicant_preapply_checks enable row level security;

-- FCRA adverse action on an application that has a consumer report. The decision ("based on the report?"), the
-- pre-adverse notice, the waiting period and the final notice are all one auditable row.
create table if not exists public.application_adverse_actions (
  id uuid primary key default gen_random_uuid(),
  application_id text not null,
  manager_user_id uuid references auth.users (id) on delete set null,
  decided_by uuid references auth.users (id) on delete set null,
  resident_email text,
  -- The Checkr order the decision was made against.
  report_id text not null,
  -- decline | condition
  action_kind text not null default 'decline' check (action_kind in ('decline', 'condition')),
  -- Did the report play any part in the decision? The manager must answer.
  based_on_report boolean not null,
  -- not_based | pre_adverse_sent | finalized | canceled
  stage text not null check (stage in ('not_based', 'pre_adverse_sent', 'finalized', 'canceled')),
  decided_at timestamptz not null default now(),
  pre_adverse_sent_at timestamptz,
  -- First moment the final notice may go out (five business days after the pre-adverse notice).
  final_due_at timestamptz,
  final_sent_at timestamptz,
  canceled_at timestamptz,
  notice_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists application_adverse_actions_application_idx
  on public.application_adverse_actions (application_id, created_at desc);

create index if not exists application_adverse_actions_manager_idx
  on public.application_adverse_actions (manager_user_id);

alter table public.application_adverse_actions enable row level security;
