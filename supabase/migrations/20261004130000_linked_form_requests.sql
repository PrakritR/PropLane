-- Linked forms owed after an application is submitted.
--
-- A manager's question can carry a rule ("when the answer is Yes, include THAT form"). When an
-- application is submitted the server evaluates the published template's rules against the
-- answers and writes one `application_form_requests` row per matched form. The applicant can
-- fill the form in themselves or share a link so someone else (a parent, a co-signer) fills it
-- in from their OWN resident account; `resident_account_links` records that applicant <-> helper
-- link so the helper's portal can list "Forms for <applicant>".
--
-- Secrets: a share link carries a 32-byte random token. Only its SHA-256 hash is stored
-- (`token_hash`); the token itself is shown once to whoever minted it. A link expires after 30
-- days and covers exactly one request.
--
-- The PostgREST surface is public: RLS only constrains WHICH rows a client role may read, never
-- which columns. So client roles are granted SELECT on an explicit column list that leaves
-- `token_hash` out, and every write goes through a server route using the service-role client,
-- which re-derives ownership from the application row (an id in a request body is never
-- authorization). Idempotent and additive.

create table if not exists public.application_form_requests (
  id uuid primary key default gen_random_uuid(),
  manager_user_id uuid not null references auth.users (id) on delete cascade,
  application_id text not null references public.manager_application_records (id) on delete cascade,
  -- The applicant's resident login when the application had one at submit time (guests have none).
  applicant_user_id uuid references auth.users (id) on delete set null,
  rule_id text not null,
  form_kind text not null check (form_kind in ('application', 'move_in')),
  form_id text not null,
  source_question_label text not null default '',
  -- The answer that triggered the rule, as the applicant gave it ("Yes"), for "From “<question>” = <answer>".
  source_answer_label text not null default '',
  needed_before_review boolean not null default false,
  token_hash text not null unique,
  status text not null default 'owed' check (status in ('owed', 'shared', 'done', 'not_needed')),
  -- The one person who opened this request's share link while signed in to a resident account. Single
  -- request scope: it is what lets a helper read and fill THIS form, never the applicant's other forms.
  helper_user_id uuid references auth.users (id) on delete set null,
  filled_by_user_id uuid references auth.users (id) on delete set null,
  completed_submission_ref text,
  completed_at timestamptz,
  fee_cents integer check (fee_cents is null or fee_cents >= 0),
  fee_session_id text,
  fee_paid_at timestamptz,
  fee_paid_by_user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days')
);

-- One request per form per application: a re-submit never doubles the list.
create unique index if not exists application_form_requests_application_form_uidx
  on public.application_form_requests (application_id, form_kind, form_id);

create index if not exists application_form_requests_manager_idx
  on public.application_form_requests (manager_user_id, status);

create index if not exists application_form_requests_applicant_idx
  on public.application_form_requests (applicant_user_id)
  where applicant_user_id is not null;

create table if not exists public.resident_account_links (
  id uuid primary key default gen_random_uuid(),
  application_id text not null references public.manager_application_records (id) on delete cascade,
  applicant_user_id uuid not null references auth.users (id) on delete cascade,
  helper_user_id uuid not null references auth.users (id) on delete cascade,
  form_request_id uuid not null references public.application_form_requests (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint resident_account_links_distinct_people check (applicant_user_id <> helper_user_id),
  constraint resident_account_links_applicant_helper_application_key
    unique (applicant_user_id, helper_user_id, application_id)
);

create index if not exists resident_account_links_helper_idx
  on public.resident_account_links (helper_user_id);

create index if not exists resident_account_links_request_idx
  on public.resident_account_links (form_request_id);

alter table public.application_form_requests enable row level security;
alter table public.resident_account_links enable row level security;

-- Client roles: SELECT only, never a write policy, never `for all`.
revoke all on public.application_form_requests from anon, authenticated;
revoke all on public.resident_account_links from anon, authenticated;

-- Every column EXCEPT token_hash.
grant select (
  id, manager_user_id, application_id, applicant_user_id, helper_user_id, rule_id, form_kind, form_id,
  source_question_label, source_answer_label, needed_before_review, status, filled_by_user_id, completed_submission_ref,
  completed_at, fee_cents, fee_paid_at, fee_paid_by_user_id, created_at, updated_at, expires_at
) on public.application_form_requests to authenticated;

grant select on public.resident_account_links to authenticated;

-- The manager the request was written for.
drop policy if exists application_form_requests_manager_read on public.application_form_requests;
create policy application_form_requests_manager_read on public.application_form_requests
  for select to authenticated using (manager_user_id = auth.uid());

-- The applicant who owes it, the helper who opened its link, and the person who filled it in.
drop policy if exists application_form_requests_applicant_read on public.application_form_requests;
create policy application_form_requests_applicant_read on public.application_form_requests
  for select to authenticated using (
    applicant_user_id = auth.uid()
    or helper_user_id = auth.uid()
    or filled_by_user_id = auth.uid()
  );

-- A link row is visible to the two people it joins, and to the manager that owns its request.
drop policy if exists resident_account_links_party_read on public.resident_account_links;
create policy resident_account_links_party_read on public.resident_account_links
  for select to authenticated using (
    applicant_user_id = auth.uid()
    or helper_user_id = auth.uid()
    or exists (
      select 1
      from public.application_form_requests r
      where r.id = resident_account_links.form_request_id
        and r.manager_user_id = auth.uid()
    )
  );

drop policy if exists test_workspace_classified_direct_deny on public.application_form_requests;
create policy test_workspace_classified_direct_deny on public.application_form_requests
  as restrictive for all to authenticated
  using (not (select public.is_classified_test_workspace_principal()))
  with check (not (select public.is_classified_test_workspace_principal()));

drop policy if exists test_workspace_classified_direct_deny on public.resident_account_links;
create policy test_workspace_classified_direct_deny on public.resident_account_links
  as restrictive for all to authenticated
  using (not (select public.is_classified_test_workspace_principal()))
  with check (not (select public.is_classified_test_workspace_principal()));
