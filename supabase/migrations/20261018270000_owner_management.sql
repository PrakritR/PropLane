-- Owner management (W17 v2): PropLane-held funds for managed workspaces. Per-workspace fee policy, an append-only
-- party ledger (owner payable, vendor payable, PropLane fee revenue, ...), the per-payment split, withdrawals,
-- repair approvals and monthly statements. Additive and idempotent. Service role only (no anon/authenticated grants).
-- Design and invariants: docs/agents/owner-management.md.

-- ---------------------------------------------------------------------------------------------
-- Fee policy: one ACTIVE row per managed workspace; history kept; a signed row's terms never change.
-- ---------------------------------------------------------------------------------------------
create table if not exists public.managed_workspace_fee_policies (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.portal_workspaces (id) on delete cascade,
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  status text not null default 'draft' check (status in ('draft', 'active', 'ended')),
  owner_share_bps integer not null default 9000 check (owner_share_bps between 5000 and 10000),
  applies_to text not null default 'rent' check (applies_to in ('rent', 'all')),
  leasing_fee_bps integer not null default 0 check (leasing_fee_bps between 0 and 10000),
  min_fee_cents integer not null default 0 check (min_fee_cents between 0 and 500000),
  reserve_target_cents integer not null default 0 check (reserve_target_cents between 0 and 100000000),
  repair_approval_threshold_cents integer not null default 25000
    check (repair_approval_threshold_cents between 0 and 5000000),
  effective_from date not null,
  ends_on date,
  sent_at timestamptz,
  signed_at timestamptz,
  accepted_via text check (accepted_via in ('owner_signature', 'admin_attested')),
  attestation_note text,
  terms_sha256 text,
  terms_snapshot jsonb,
  ended_at timestamptz,
  ended_by_role text check (ended_by_role in ('admin', 'owner', 'system')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint managed_policy_dates check (ends_on is null or ends_on >= effective_from),
  constraint managed_policy_active_accepted check (
    status <> 'active' or (signed_at is not null and terms_sha256 is not null and accepted_via is not null)
  ),
  constraint managed_policy_attested_note check (
    accepted_via is distinct from 'admin_attested' or length(trim(coalesce(attestation_note, ''))) >= 8
  )
);
create unique index if not exists managed_policy_one_active_per_workspace
  on public.managed_workspace_fee_policies (workspace_id) where status = 'active';
create index if not exists managed_policy_workspace_idx on public.managed_workspace_fee_policies (workspace_id, created_at desc);
create index if not exists managed_policy_owner_idx on public.managed_workspace_fee_policies (owner_user_id, status);

create or replace function public.managed_policy_terms_immutable()
returns trigger language plpgsql as $$
begin
  if old.signed_at is not null and (
    new.workspace_id is distinct from old.workspace_id or
    new.owner_user_id is distinct from old.owner_user_id or
    new.owner_share_bps is distinct from old.owner_share_bps or
    new.applies_to is distinct from old.applies_to or
    new.leasing_fee_bps is distinct from old.leasing_fee_bps or
    new.min_fee_cents is distinct from old.min_fee_cents or
    new.effective_from is distinct from old.effective_from or
    new.signed_at is distinct from old.signed_at or
    new.accepted_via is distinct from old.accepted_via or
    new.terms_sha256 is distinct from old.terms_sha256 or
    new.terms_snapshot is distinct from old.terms_snapshot
  ) then
    raise exception 'A signed fee policy cannot be edited. Draft a new version.';
  end if;
  if old.status = 'ended' and new.status <> 'ended' then
    raise exception 'An ended fee policy cannot be reopened.';
  end if;
  return new;
end;
$$;
drop trigger if exists managed_policy_terms_immutable on public.managed_workspace_fee_policies;
create trigger managed_policy_terms_immutable
  before update on public.managed_workspace_fee_policies
  for each row execute function public.managed_policy_terms_immutable();

-- ---------------------------------------------------------------------------------------------
-- Party ledger: append-only, balanced journals. debit positive, credit negative.
-- ---------------------------------------------------------------------------------------------
create table if not exists public.party_ledger_journals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.portal_workspaces (id) on delete set null,
  kind text not null check (kind in (
    'rent_capture', 'refund', 'dispute_opened', 'dispute_won', 'dispute_lost', 'vendor_bill', 'vendor_bill_reversal',
    'withdrawal_reserve', 'withdrawal_complete', 'withdrawal_failed', 'adjustment', 'directory_claim'
  )),
  idempotency_key text not null unique,
  payload_hash text not null,
  source_type text,
  source_id text,
  stripe_object_id text,
  detail jsonb not null default '{}'::jsonb,
  posted_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists party_ledger_journals_workspace_idx on public.party_ledger_journals (workspace_id, posted_at desc);
create index if not exists party_ledger_journals_stripe_idx on public.party_ledger_journals (stripe_object_id);
create index if not exists party_ledger_journals_source_idx on public.party_ledger_journals (source_type, source_id);

create table if not exists public.party_ledger_lines (
  id uuid primary key default gen_random_uuid(),
  journal_id uuid not null references public.party_ledger_journals (id) on delete cascade,
  account text not null check (account in (
    'platform_cash', 'owner_payable', 'vendor_payable', 'proplane_fee_revenue', 'processing_recovery',
    'tenant_deposit_liability', 'withdrawal_in_flight', 'dispute_hold', 'platform_dispute_expense'
  )),
  party_id text,
  workspace_id uuid,
  amount_cents bigint not null check (amount_cents <> 0),
  available_on timestamptz,
  created_at timestamptz not null default now(),
  constraint party_ledger_lines_party check (
    account not in ('owner_payable', 'vendor_payable', 'withdrawal_in_flight', 'dispute_hold') or party_id is not null
  )
);
create index if not exists party_ledger_lines_party_idx on public.party_ledger_lines (account, party_id, workspace_id);
create index if not exists party_ledger_lines_journal_idx on public.party_ledger_lines (journal_id);
create index if not exists party_ledger_lines_workspace_idx on public.party_ledger_lines (workspace_id, account);

-- Append-only: a posted journal is never edited or removed (corrections are new journals).
create or replace function public.party_ledger_append_only()
returns trigger language plpgsql as $$
begin
  raise exception 'The party ledger is append-only.';
end;
$$;
drop trigger if exists party_ledger_lines_append_only on public.party_ledger_lines;
create trigger party_ledger_lines_append_only
  before update or delete on public.party_ledger_lines
  for each row execute function public.party_ledger_append_only();
-- The one permitted change to a posted journal: a deleted workspace detaches itself (the foreign key's `on delete set null`),
-- so deleting a workspace never fails and its money history survives with no workspace.
create or replace function public.party_ledger_journals_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and old.workspace_id is not null and new.workspace_id is null
     and (to_jsonb(new) - 'workspace_id') = (to_jsonb(old) - 'workspace_id') then
    return new;
  end if;
  raise exception 'The party ledger is append-only.';
end;
$$;
drop trigger if exists party_ledger_journals_append_only on public.party_ledger_journals;
create trigger party_ledger_journals_append_only
  before update on public.party_ledger_journals
  for each row execute function public.party_ledger_journals_guard();

-- Every journal sums to zero, checked at commit.
create or replace function public.party_ledger_zero_sum()
returns trigger language plpgsql as $$
declare v_sum bigint; v_count integer;
begin
  select coalesce(sum(amount_cents), 0), count(*) into v_sum, v_count from public.party_ledger_lines where journal_id = new.journal_id;
  if v_sum <> 0 or v_count < 2 then
    raise exception 'Party ledger journal % is unbalanced (sum %, lines %)', new.journal_id, v_sum, v_count;
  end if;
  return null;
end;
$$;
drop trigger if exists party_ledger_lines_zero_sum on public.party_ledger_lines;
create constraint trigger party_ledger_lines_zero_sum
  after insert on public.party_ledger_lines
  deferrable initially deferred
  for each row execute function public.party_ledger_zero_sum();

-- ---------------------------------------------------------------------------------------------
-- Per-payment split detail (the statement and pro-rata refunds read these; the journal is the money truth).
-- ---------------------------------------------------------------------------------------------
create table if not exists public.managed_rent_allocations (
  id uuid primary key default gen_random_uuid(),
  policy_id uuid references public.managed_workspace_fee_policies (id) on delete set null,
  workspace_id uuid not null references public.portal_workspaces (id) on delete cascade,
  journal_id uuid references public.party_ledger_journals (id) on delete set null,
  property_id text,
  owner_user_id uuid references auth.users (id) on delete set null,
  charge_id text not null,
  charge_kind text not null,
  liability_class text not null check (liability_class in ('income', 'deposit')),
  fee_applies boolean not null default false,
  resident_email text,
  stripe_payment_intent_id text not null,
  stripe_charge_id text,
  month_key text not null check (month_key ~ '^\d{4}-\d{2}$'),
  paid_at timestamptz not null default now(),
  available_on timestamptz,
  principal_cents integer not null check (principal_cents > 0),
  resident_added_cents integer not null default 0 check (resident_added_cents >= 0),
  owner_borne_cents integer not null default 0 check (owner_borne_cents >= 0),
  distributable_cents integer not null check (distributable_cents > 0),
  fee_cents integer not null default 0 check (fee_cents >= 0),
  leasing_cents integer not null default 0 check (leasing_cents >= 0),
  owner_cents integer not null default 0 check (owner_cents >= 0),
  deposit_cents integer not null default 0 check (deposit_cents >= 0),
  refunded_principal_cents integer not null default 0 check (refunded_principal_cents >= 0),
  refunded_fee_cents integer not null default 0 check (refunded_fee_cents >= 0),
  refunded_owner_cents integer not null default 0 check (refunded_owner_cents >= 0),
  refunded_borne_cents integer not null default 0 check (refunded_borne_cents >= 0),
  disputed_cents integer not null default 0 check (disputed_cents >= 0),
  status text not null default 'settled'
    check (status in ('settled', 'partially_refunded', 'refunded', 'disputed', 'dispute_lost')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint managed_alloc_source unique (stripe_payment_intent_id, charge_id),
  constraint managed_alloc_distributable check (distributable_cents = principal_cents - owner_borne_cents),
  constraint managed_alloc_split check (
    (liability_class = 'income' and deposit_cents = 0 and owner_cents + fee_cents + leasing_cents = distributable_cents)
    or (liability_class = 'deposit' and owner_cents = 0 and fee_cents = 0 and leasing_cents = 0 and deposit_cents = distributable_cents)
  ),
  constraint managed_alloc_refund_bound check (refunded_principal_cents <= principal_cents)
);
create index if not exists managed_alloc_workspace_month_idx on public.managed_rent_allocations (workspace_id, month_key);
create index if not exists managed_alloc_policy_month_idx on public.managed_rent_allocations (policy_id, month_key);
create index if not exists managed_alloc_charge_idx on public.managed_rent_allocations (stripe_charge_id);
create index if not exists managed_alloc_property_idx on public.managed_rent_allocations (property_id, month_key);
create unique index if not exists managed_alloc_one_leasing_fee
  on public.managed_rent_allocations (policy_id, lower(resident_email)) where leasing_cents > 0;

-- ---------------------------------------------------------------------------------------------
-- Withdrawals: owner (per workspace) and vendor (across workspaces). One in flight per party.
-- ---------------------------------------------------------------------------------------------
create table if not exists public.party_withdrawals (
  id uuid primary key default gen_random_uuid(),
  party_kind text not null check (party_kind in ('owner', 'vendor')),
  party_id text not null,
  workspace_id uuid,
  amount_cents bigint not null check (amount_cents > 0),
  destination_account_id text not null,
  idempotency_key text not null unique,
  status text not null default 'reserved' check (status in ('reserved', 'unknown', 'completed', 'failed')),
  stripe_transfer_id text,
  stripe_payout_id text,
  payout_error text,
  failure_reason text,
  source text not null default 'manual' check (source in ('manual', 'weekly_batch')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
create unique index if not exists party_withdrawals_one_in_flight
  on public.party_withdrawals (party_kind, party_id, coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where status in ('reserved', 'unknown');
create index if not exists party_withdrawals_party_idx on public.party_withdrawals (party_kind, party_id, created_at desc);

-- ---------------------------------------------------------------------------------------------
-- Repair approvals on managed workspaces (the vendor bill posts only after an owner's yes above the threshold).
-- ---------------------------------------------------------------------------------------------
create table if not exists public.owner_expenses (
  id uuid primary key default gen_random_uuid(),
  policy_id uuid references public.managed_workspace_fee_policies (id) on delete set null,
  workspace_id uuid not null references public.portal_workspaces (id) on delete cascade,
  property_id text,
  owner_user_id uuid references auth.users (id) on delete set null,
  source_type text not null check (source_type in ('work_order', 'invoice', 'manual')),
  source_id text not null,
  vendor_party_id text,
  title text not null,
  vendor_label text,
  amount_cents integer not null check (amount_cents > 0),
  status text not null default 'pending_owner'
    check (status in ('pending_owner', 'auto_approved', 'approved', 'declined', 'posted')),
  threshold_cents integer not null default 0,
  requested_at timestamptz not null default now(),
  approval_phone_key text,
  approval_sent_at timestamptz,
  decided_at timestamptz,
  decided_via text check (decided_via in ('sms', 'portal', 'auto')),
  posted_journal_id uuid references public.party_ledger_journals (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint owner_expenses_source unique (source_type, source_id)
);
create index if not exists owner_expenses_workspace_idx on public.owner_expenses (workspace_id, status);
create index if not exists owner_expenses_owner_pending_idx
  on public.owner_expenses (owner_user_id, status) where status = 'pending_owner';

-- ---------------------------------------------------------------------------------------------
-- Monthly statements (frozen snapshots that were emailed / texted) and reconciliation flags.
-- ---------------------------------------------------------------------------------------------
create table if not exists public.owner_statements (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.portal_workspaces (id) on delete cascade,
  owner_user_id uuid references auth.users (id) on delete set null,
  month_key text not null check (month_key ~ '^\d{4}-\d{2}$'),
  totals jsonb not null,
  emailed_at timestamptz,
  texted_at timestamptz,
  created_at timestamptz not null default now(),
  constraint owner_statements_once unique (workspace_id, month_key)
);
create index if not exists owner_statements_owner_idx on public.owner_statements (owner_user_id, month_key desc);

create table if not exists public.owner_ledger_flags (
  id uuid primary key default gen_random_uuid(),
  check_name text not null,
  subject text not null,
  detail jsonb not null default '{}'::jsonb,
  day date not null default current_date,
  created_at timestamptz not null default now(),
  constraint owner_ledger_flags_once unique (check_name, subject, day)
);

-- ---------------------------------------------------------------------------------------------
-- Access: service role only.
-- ---------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'managed_workspace_fee_policies', 'party_ledger_journals', 'party_ledger_lines', 'managed_rent_allocations',
    'party_withdrawals', 'owner_expenses', 'owner_statements', 'owner_ledger_flags'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- post_party_journal: the one atomic, idempotent poster. Replaying a key with the same payload returns the
-- existing journal; replaying it with a different payload raises.
-- p_lines: [{account, party_id?, workspace_id?, amount_cents (signed), available_on?}]
-- ---------------------------------------------------------------------------------------------
create or replace function public.post_party_journal(
  p_workspace uuid, p_kind text, p_key text, p_source_type text, p_source_id text, p_stripe text,
  p_detail jsonb, p_lines jsonb, p_posted_at timestamptz default null
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_hash text; v_existing public.party_ledger_journals%rowtype; v_id uuid; v_line jsonb; v_sum bigint := 0;
begin
  if p_key is null or length(trim(p_key)) = 0 or jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) < 2 then
    raise exception 'A journal needs an idempotency key and at least two lines';
  end if;
  v_hash := md5(jsonb_build_object('k', p_kind, 'l', p_lines)::text);
  select * into v_existing from public.party_ledger_journals where idempotency_key = p_key;
  if found then
    if v_existing.payload_hash <> v_hash then
      raise exception 'Journal % was already posted with different lines', p_key;
    end if;
    return jsonb_build_object('created', false, 'journal_id', v_existing.id);
  end if;
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_sum := v_sum + (v_line->>'amount_cents')::bigint;
  end loop;
  if v_sum <> 0 then raise exception 'Journal % does not balance (%)', p_key, v_sum; end if;
  begin
    insert into public.party_ledger_journals (workspace_id, kind, idempotency_key, payload_hash, source_type, source_id, stripe_object_id, detail, posted_at)
      values (p_workspace, p_kind, p_key, v_hash, p_source_type, p_source_id, p_stripe, coalesce(p_detail, '{}'::jsonb), coalesce(p_posted_at, now()))
      returning id into v_id;
  exception when unique_violation then
    select * into v_existing from public.party_ledger_journals where idempotency_key = p_key;
    if v_existing.payload_hash <> v_hash then raise exception 'Journal % was already posted with different lines', p_key; end if;
    return jsonb_build_object('created', false, 'journal_id', v_existing.id);
  end;
  insert into public.party_ledger_lines (journal_id, account, party_id, workspace_id, amount_cents, available_on)
    select v_id, l->>'account', nullif(l->>'party_id', ''), coalesce(nullif(l->>'workspace_id', '')::uuid, p_workspace),
           (l->>'amount_cents')::bigint, nullif(l->>'available_on', '')::timestamptz
      from jsonb_array_elements(p_lines) l;
  return jsonb_build_object('created', true, 'journal_id', v_id);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- party_balance: owed / matured / pending for one payable account.
-- ---------------------------------------------------------------------------------------------
create or replace function public.party_balance(p_account text, p_party text, p_workspace uuid)
returns table (owed bigint, matured bigint, pending bigint)
language sql stable security definer set search_path = public, pg_temp as $$
  select
    coalesce(-sum(l.amount_cents), 0)::bigint as owed,
    coalesce(-sum(l.amount_cents) filter (where l.available_on is null or l.available_on <= now()), 0)::bigint as matured,
    coalesce(-sum(l.amount_cents) filter (where l.available_on > now()), 0)::bigint as pending
  from public.party_ledger_lines l
  where l.account = p_account and l.party_id = p_party
    and (p_workspace is null or l.workspace_id = p_workspace);
$$;

-- ---------------------------------------------------------------------------------------------
-- managed_month_totals: what the fee math needs (fee-applicable distributable collected this month, net of refunds, and the
-- monthly fee already taken). Allocation rows are written in the same transaction as their journal.
-- ---------------------------------------------------------------------------------------------
create or replace function public.managed_month_totals(p_policy uuid, p_month text)
returns table (cum_base bigint, monthly_fee bigint)
language sql stable security definer set search_path = public, pg_temp as $$
  select
    coalesce(sum(greatest(a.distributable_cents - (a.refunded_owner_cents + a.refunded_fee_cents), 0)) filter (where a.fee_applies), 0)::bigint,
    coalesce(sum(greatest(a.fee_cents - least(a.refunded_fee_cents, a.fee_cents), 0)) filter (where a.fee_applies), 0)::bigint
  from public.managed_rent_allocations a
  where a.policy_id = p_policy and a.month_key = p_month;
$$;

-- ---------------------------------------------------------------------------------------------
-- credit_managed_capture: allocate one verified platform capture to owner / PropLane / deposits, atomically.
-- p_rows: [{charge_id, charge_kind, liability_class, fee_applies, resident_email, property_id, principal_cents,
--           resident_added_cents, owner_borne_cents, distributable_cents, fee_cents, leasing_cents, owner_cents,
--           deposit_cents, paid_at}]
-- The caller computed the fee from the totals it saw; `conflict` is returned if they moved. The hard bounds are enforced here.
-- ---------------------------------------------------------------------------------------------
create or replace function public.credit_managed_capture(
  p_policy uuid, p_workspace uuid, p_key text, p_pi text, p_stripe_charge text, p_month text, p_available_on timestamptz,
  p_gross bigint, p_expect_base bigint, p_expect_fee bigint, p_rows jsonb
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_pol public.managed_workspace_fee_policies%rowtype;
  v_existing public.party_ledger_journals%rowtype;
  v_row jsonb; v_cum bigint; v_taken bigint;
  v_sum_dist bigint := 0; v_sum_owner bigint := 0; v_sum_fee bigint := 0; v_sum_leasing bigint := 0; v_sum_deposit bigint := 0;
  v_sum_base_new bigint := 0; v_sum_monthly_new bigint := 0; v_processing bigint;
  v_after bigint; v_base bigint; v_floor bigint; v_target bigint; v_fee_bps integer;
  v_lines jsonb := '[]'::jsonb; v_posted jsonb; v_journal uuid; v_owner_party text;
begin
  select * into v_existing from public.party_ledger_journals where idempotency_key = p_key;
  if found then return jsonb_build_object('status', 'exists', 'journal_id', v_existing.id); end if;

  select * into v_pol from public.managed_workspace_fee_policies where id = p_policy for update;
  if not found or v_pol.workspace_id is distinct from p_workspace or v_pol.status <> 'active' or v_pol.signed_at is null then
    return jsonb_build_object('status', 'refused', 'reason', 'policy_not_active');
  end if;

  select t.cum_base, t.monthly_fee into v_cum, v_taken from public.managed_month_totals(p_policy, p_month) t;
  if v_cum is distinct from p_expect_base or v_taken is distinct from p_expect_fee then
    return jsonb_build_object('status', 'conflict', 'cum_base', v_cum, 'monthly_fee', v_taken);
  end if;

  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_sum_dist := v_sum_dist + (v_row->>'distributable_cents')::bigint;
    v_sum_owner := v_sum_owner + (v_row->>'owner_cents')::bigint;
    v_sum_fee := v_sum_fee + (v_row->>'fee_cents')::bigint;
    v_sum_leasing := v_sum_leasing + (v_row->>'leasing_cents')::bigint;
    v_sum_deposit := v_sum_deposit + (v_row->>'deposit_cents')::bigint;
    if (v_row->>'fee_applies')::boolean then
      v_sum_base_new := v_sum_base_new + (v_row->>'distributable_cents')::bigint;
      v_sum_monthly_new := v_sum_monthly_new + (v_row->>'fee_cents')::bigint;
      if (v_row->>'leasing_cents')::bigint > ((v_row->>'distributable_cents')::bigint * v_pol.leasing_fee_bps) / 10000 then
        return jsonb_build_object('status', 'refused', 'reason', 'leasing_over_policy');
      end if;
    elsif (v_row->>'fee_cents')::bigint <> 0 or (v_row->>'leasing_cents')::bigint <> 0 then
      return jsonb_build_object('status', 'refused', 'reason', 'fee_on_unfeed_charge');
    end if;
    if (v_row->>'leasing_cents')::bigint > 0 and v_pol.leasing_fee_bps <= 0 then
      return jsonb_build_object('status', 'refused', 'reason', 'leasing_over_policy');
    end if;
  end loop;

  -- Hard bound: the month's monthly fee never exceeds the policy's target for the month's cumulative base.
  v_fee_bps := 10000 - v_pol.owner_share_bps;
  v_after := v_cum + v_sum_base_new;
  v_base := (v_after * v_fee_bps) / 10000;
  v_floor := least(v_pol.min_fee_cents, v_after);
  v_target := least(greatest(v_base, v_floor), v_after);
  if v_taken + v_sum_monthly_new > v_target then
    return jsonb_build_object('status', 'refused', 'reason', 'fee_over_policy');
  end if;

  v_processing := p_gross - v_sum_dist;
  if v_processing < 0 then return jsonb_build_object('status', 'refused', 'reason', 'bad_gross'); end if;
  if v_sum_owner + v_sum_fee + v_sum_leasing + v_sum_deposit <> v_sum_dist then
    return jsonb_build_object('status', 'refused', 'reason', 'split_mismatch');
  end if;

  v_owner_party := 'owner:' || v_pol.owner_user_id::text;
  v_lines := jsonb_build_array(jsonb_build_object('account', 'platform_cash', 'amount_cents', p_gross));
  if v_sum_owner > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', 'owner_payable', 'party_id', v_owner_party, 'amount_cents', -v_sum_owner, 'available_on', p_available_on));
  end if;
  if v_sum_fee + v_sum_leasing > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', 'proplane_fee_revenue', 'amount_cents', -(v_sum_fee + v_sum_leasing)));
  end if;
  if v_processing > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', 'processing_recovery', 'amount_cents', -v_processing));
  end if;
  if v_sum_deposit > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', 'tenant_deposit_liability', 'amount_cents', -v_sum_deposit));
  end if;

  v_posted := public.post_party_journal(p_workspace, 'rent_capture', p_key, 'stripe_payment_intent', p_pi, p_pi,
    jsonb_build_object('policy_id', p_policy, 'stripe_charge', p_stripe_charge, 'month', p_month, 'gross_cents', p_gross,
      'owner_cents', v_sum_owner, 'fee_cents', v_sum_fee + v_sum_leasing, 'processing_cents', v_processing, 'deposit_cents', v_sum_deposit,
      'charges', (select jsonb_agg(jsonb_build_object('charge_id', r->>'charge_id', 'kind', r->>'charge_kind', 'property_id', r->>'property_id',
        'principal_cents', (r->>'principal_cents')::bigint, 'owner_cents', (r->>'owner_cents')::bigint,
        'fee_cents', (r->>'fee_cents')::bigint + (r->>'leasing_cents')::bigint) ) from jsonb_array_elements(p_rows) r)),
    v_lines);
  v_journal := (v_posted->>'journal_id')::uuid;

  insert into public.managed_rent_allocations (
    policy_id, workspace_id, journal_id, property_id, owner_user_id, charge_id, charge_kind, liability_class, fee_applies,
    resident_email, stripe_payment_intent_id, stripe_charge_id, month_key, paid_at, available_on, principal_cents,
    resident_added_cents, owner_borne_cents, distributable_cents, fee_cents, leasing_cents, owner_cents, deposit_cents
  )
  select p_policy, p_workspace, v_journal, nullif(r->>'property_id', ''), v_pol.owner_user_id, r->>'charge_id', r->>'charge_kind',
         r->>'liability_class', (r->>'fee_applies')::boolean, nullif(lower(r->>'resident_email'), ''), p_pi, p_stripe_charge, p_month,
         coalesce((r->>'paid_at')::timestamptz, now()), p_available_on, (r->>'principal_cents')::integer,
         (r->>'resident_added_cents')::integer, (r->>'owner_borne_cents')::integer, (r->>'distributable_cents')::integer,
         (r->>'fee_cents')::integer, (r->>'leasing_cents')::integer, (r->>'owner_cents')::integer, (r->>'deposit_cents')::integer
    from jsonb_array_elements(p_rows) r
  on conflict (stripe_payment_intent_id, charge_id) do nothing;

  return jsonb_build_object('status', 'created', 'journal_id', v_journal);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- apply_managed_refund: reverse a refund of principal on one allocation, pro rata, once per refund id.
-- ---------------------------------------------------------------------------------------------
create or replace function public.apply_managed_refund(p_alloc uuid, p_refund text, p_amount bigint, p_posted timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a public.managed_rent_allocations%rowtype;
  v_key text; v_existing public.party_ledger_journals%rowtype;
  v_rp bigint; v_rf bigint; v_ro bigint; v_rb bigint; v_fee_total bigint;
  v_fee_part bigint; v_borne_part bigint; v_owner_part bigint; v_deposit_part bigint := 0;
  v_lines jsonb; v_owner_party text; v_posted jsonb; v_status text;
begin
  select * into a from public.managed_rent_allocations where id = p_alloc for update;
  if not found then return jsonb_build_object('status', 'refused', 'reason', 'no_allocation'); end if;
  v_key := 'refund:' || p_refund || ':' || p_alloc::text;
  select * into v_existing from public.party_ledger_journals where idempotency_key = v_key;
  if found then return jsonb_build_object('status', 'exists', 'journal_id', v_existing.id); end if;

  v_rp := a.principal_cents - a.refunded_principal_cents;
  if p_amount <= 0 or p_amount > v_rp then return jsonb_build_object('status', 'refused', 'reason', 'refund_exceeds_payment'); end if;
  v_fee_total := a.fee_cents + a.leasing_cents;
  v_rf := v_fee_total - a.refunded_fee_cents;
  v_ro := a.owner_cents - a.refunded_owner_cents;
  v_rb := a.owner_borne_cents - a.refunded_borne_cents;
  if a.liability_class = 'deposit' then
    v_deposit_part := p_amount - (case when p_amount = v_rp then v_rb else ((v_rb * p_amount * 2 + v_rp) / (v_rp * 2)) end);
    v_borne_part := p_amount - v_deposit_part; v_fee_part := 0; v_owner_part := 0;
  elsif p_amount = v_rp then
    v_fee_part := v_rf; v_borne_part := v_rb; v_owner_part := v_ro;
  else
    v_fee_part := (v_rf * p_amount * 2 + v_rp) / (v_rp * 2);
    v_borne_part := (v_rb * p_amount * 2 + v_rp) / (v_rp * 2);
    v_owner_part := p_amount - v_fee_part - v_borne_part;
    if v_owner_part < 0 or v_owner_part > v_ro then return jsonb_build_object('status', 'refused', 'reason', 'owner_part_out_of_range'); end if;
  end if;
  if v_fee_part > v_rf or v_borne_part > v_rb then return jsonb_build_object('status', 'refused', 'reason', 'part_out_of_range'); end if;

  v_owner_party := 'owner:' || coalesce(a.owner_user_id::text, '');
  v_lines := jsonb_build_array(jsonb_build_object('account', 'platform_cash', 'amount_cents', -p_amount));
  -- The debit carries the credit's own availability, so a refund of money that has not matured yet nets against that pending credit.
  if v_owner_part > 0 then v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', 'owner_payable', 'party_id', v_owner_party, 'amount_cents', v_owner_part, 'available_on', a.available_on)); end if;
  if v_fee_part > 0 then v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', 'proplane_fee_revenue', 'amount_cents', v_fee_part)); end if;
  if v_borne_part > 0 then v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', 'processing_recovery', 'amount_cents', v_borne_part)); end if;
  if v_deposit_part > 0 then v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', 'tenant_deposit_liability', 'amount_cents', v_deposit_part)); end if;

  v_posted := public.post_party_journal(a.workspace_id, 'refund', v_key, 'stripe_refund', p_refund, a.stripe_charge_id,
    jsonb_build_object('allocation_id', p_alloc, 'charge_id', a.charge_id, 'amount_cents', p_amount, 'owner_cents', v_owner_part,
      'fee_cents', v_fee_part, 'borne_cents', v_borne_part, 'deposit_cents', v_deposit_part, 'property_id', a.property_id), v_lines, p_posted);

  v_status := case when a.refunded_principal_cents + p_amount >= a.principal_cents then 'refunded' else 'partially_refunded' end;
  update public.managed_rent_allocations set
    refunded_principal_cents = refunded_principal_cents + p_amount,
    refunded_fee_cents = refunded_fee_cents + v_fee_part,
    refunded_owner_cents = refunded_owner_cents + v_owner_part,
    refunded_borne_cents = refunded_borne_cents + v_borne_part,
    status = case when status in ('disputed', 'dispute_lost') then status else v_status end,
    updated_at = now()
  where id = p_alloc;
  return jsonb_build_object('status', 'created', 'journal_id', v_posted->>'journal_id', 'owner_part', v_owner_part, 'fee_part', v_fee_part);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- apply_managed_dispute: opened freezes the owner's share, won releases it, lost writes it off. The disputed amount is
-- spread pro rata over the PaymentIntent's allocations (by remaining principal); processing is the remainder.
-- ---------------------------------------------------------------------------------------------
create or replace function public.apply_managed_dispute(
  p_pi text, p_dispute text, p_phase text, p_amount bigint, p_dispute_fee bigint
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a record; v_total_rp bigint := 0; v_ratio_num bigint; v_open public.party_ledger_journals%rowtype;
  v_key text; v_existing public.party_ledger_journals%rowtype; v_lines jsonb := '[]'::jsonb;
  v_owner_d bigint; v_fee_d bigint; v_dep_d bigint; v_sum_owner bigint := 0; v_sum_fee bigint := 0; v_sum_dep bigint := 0;
  v_proc bigint; v_posted jsonb; v_ws uuid; v_owner_party text; v_seen boolean := false; v_detail jsonb;
  v_line jsonb; v_ratio_den bigint; v_last_id uuid;
begin
  if p_phase not in ('opened', 'won', 'lost') then raise exception 'Unknown dispute phase'; end if;
  v_key := 'dispute:' || p_dispute || ':' || p_phase;
  select * into v_existing from public.party_ledger_journals where idempotency_key = v_key;
  if found then return jsonb_build_object('status', 'exists', 'journal_id', v_existing.id); end if;

  for a in select * from public.managed_rent_allocations where stripe_payment_intent_id = p_pi order by id for update loop
    v_total_rp := v_total_rp + (a.principal_cents - a.refunded_principal_cents);
    v_ws := a.workspace_id; v_seen := true;
  end loop;
  if not v_seen then return jsonb_build_object('status', 'refused', 'reason', 'no_allocation'); end if;

  if p_phase = 'opened' then
    if p_amount <= 0 then return jsonb_build_object('status', 'refused', 'reason', 'bad_amount'); end if;
    v_ratio_den := greatest(v_total_rp, 1);
    for a in select * from public.managed_rent_allocations where stripe_payment_intent_id = p_pi order by id loop
      v_owner_d := least(a.owner_cents - a.refunded_owner_cents, ((a.owner_cents - a.refunded_owner_cents) * least(p_amount, v_ratio_den) * 2 + v_ratio_den) / (v_ratio_den * 2));
      v_owner_party := 'owner:' || coalesce(a.owner_user_id::text, '');
      if v_owner_d > 0 then
        v_lines := v_lines || jsonb_build_array(
          jsonb_build_object('account', 'owner_payable', 'party_id', v_owner_party, 'workspace_id', a.workspace_id, 'amount_cents', v_owner_d, 'available_on', a.available_on),
          jsonb_build_object('account', 'dispute_hold', 'party_id', v_owner_party, 'workspace_id', a.workspace_id, 'amount_cents', -v_owner_d));
      end if;
      update public.managed_rent_allocations set disputed_cents = p_amount, status = case when status = 'refunded' then status else 'disputed' end, updated_at = now() where id = a.id;
    end loop;
    if jsonb_array_length(v_lines) < 2 then
      -- Nothing owner-side to freeze (e.g. a deposit): still record the dispute once.
      v_lines := jsonb_build_array(jsonb_build_object('account', 'platform_cash', 'amount_cents', 1), jsonb_build_object('account', 'platform_cash', 'amount_cents', -1));
    end if;
    v_posted := public.post_party_journal(v_ws, 'dispute_opened', v_key, 'stripe_dispute', p_dispute, p_pi,
      jsonb_build_object('amount_cents', p_amount, 'pi', p_pi), v_lines);
    return jsonb_build_object('status', 'created', 'journal_id', v_posted->>'journal_id');
  end if;

  select * into v_open from public.party_ledger_journals where idempotency_key = 'dispute:' || p_dispute || ':opened';
  if not found then return jsonb_build_object('status', 'refused', 'reason', 'dispute_not_opened'); end if;
  if exists (select 1 from public.party_ledger_journals where idempotency_key in ('dispute:' || p_dispute || ':won', 'dispute:' || p_dispute || ':lost')) then
    return jsonb_build_object('status', 'refused', 'reason', 'dispute_already_closed');
  end if;

  if p_phase = 'won' then
    -- Exactly reverse the opened journal's lines.
    for v_line in select jsonb_build_object('account', l.account, 'party_id', l.party_id, 'workspace_id', l.workspace_id, 'amount_cents', -l.amount_cents, 'available_on', l.available_on)
                    from public.party_ledger_lines l where l.journal_id = v_open.id loop
      v_lines := v_lines || jsonb_build_array(v_line);
    end loop;
    v_posted := public.post_party_journal(v_ws, 'dispute_won', v_key, 'stripe_dispute', p_dispute, p_pi, jsonb_build_object('pi', p_pi), v_lines);
    update public.managed_rent_allocations set disputed_cents = 0,
      status = case when refunded_principal_cents >= principal_cents then 'refunded' when refunded_principal_cents > 0 then 'partially_refunded' else 'settled' end,
      updated_at = now() where stripe_payment_intent_id = p_pi;
    return jsonb_build_object('status', 'created', 'journal_id', v_posted->>'journal_id');
  end if;

  -- lost: release the hold, write off the fee and deposit shares pro rata, the rest is processing; platform cash pays amount + fee.
  v_ratio_den := greatest(v_total_rp, 1);
  for a in select * from public.managed_rent_allocations where stripe_payment_intent_id = p_pi order by id loop
    v_last_id := a.id;
    v_fee_d := (((a.fee_cents + a.leasing_cents) - a.refunded_fee_cents) * least(p_amount, v_ratio_den) * 2 + v_ratio_den) / (v_ratio_den * 2);
    v_dep_d := case when a.liability_class = 'deposit' then (greatest(a.deposit_cents - (a.refunded_principal_cents - a.refunded_borne_cents), 0) * least(p_amount, v_ratio_den) * 2 + v_ratio_den) / (v_ratio_den * 2) else 0 end;
    v_sum_fee := v_sum_fee + v_fee_d; v_sum_dep := v_sum_dep + v_dep_d;
  end loop;
  select coalesce(sum(-l.amount_cents), 0) into v_sum_owner from public.party_ledger_lines l where l.journal_id = v_open.id and l.account = 'dispute_hold';
  v_proc := p_amount - v_sum_owner - v_sum_fee - v_sum_dep;
  if v_proc < 0 then
    -- Rounding spill: take it from the fee write-off.
    v_sum_fee := v_sum_fee + v_proc; v_proc := 0;
    if v_sum_fee < 0 then return jsonb_build_object('status', 'refused', 'reason', 'dispute_amount_mismatch'); end if;
  end if;
  v_lines := '[]'::jsonb;
  for v_line in select jsonb_build_object('account', 'dispute_hold', 'party_id', l.party_id, 'workspace_id', l.workspace_id, 'amount_cents', -l.amount_cents)
                  from public.party_ledger_lines l where l.journal_id = v_open.id and l.account = 'dispute_hold' loop
    v_lines := v_lines || jsonb_build_array(v_line);
  end loop;
  if v_sum_fee > 0 then v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', 'proplane_fee_revenue', 'amount_cents', v_sum_fee)); end if;
  if v_sum_dep > 0 then v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', 'tenant_deposit_liability', 'amount_cents', v_sum_dep)); end if;
  if v_proc > 0 then v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', 'processing_recovery', 'amount_cents', v_proc)); end if;
  if p_dispute_fee > 0 then v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', 'platform_dispute_expense', 'amount_cents', p_dispute_fee)); end if;
  v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', 'platform_cash', 'amount_cents', -(p_amount + p_dispute_fee)));
  v_posted := public.post_party_journal(v_ws, 'dispute_lost', v_key, 'stripe_dispute', p_dispute, p_pi,
    jsonb_build_object('pi', p_pi, 'amount_cents', p_amount, 'dispute_fee_cents', p_dispute_fee), v_lines);
  update public.managed_rent_allocations set status = 'dispute_lost', updated_at = now() where stripe_payment_intent_id = p_pi;
  return jsonb_build_object('status', 'created', 'journal_id', v_posted->>'journal_id');
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Withdrawals: reserve (under a per-party lock, against the ledger), complete, fail.
-- ---------------------------------------------------------------------------------------------
create or replace function public.reserve_party_withdrawal(
  p_kind text, p_party text, p_workspace uuid, p_amount bigint, p_destination text, p_key text, p_reserve bigint, p_source text default 'manual'
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_existing public.party_withdrawals%rowtype; v_account text; v_owed bigint; v_matured bigint; v_pending bigint; v_available bigint;
  v_id uuid; v_ws uuid;
begin
  if p_kind not in ('owner', 'vendor') or p_amount <= 0 or length(coalesce(p_destination, '')) < 5 then
    return jsonb_build_object('status', 'refused', 'reason', 'bad_request');
  end if;
  perform pg_advisory_xact_lock(hashtext('party-withdrawal:' || p_kind || ':' || p_party || ':' || coalesce(p_workspace::text, '')));
  select * into v_existing from public.party_withdrawals where idempotency_key = p_key;
  if found then
    return jsonb_build_object('status', 'exists', 'withdrawal_id', v_existing.id, 'withdrawal_status', v_existing.status);
  end if;
  if exists (select 1 from public.party_withdrawals w where w.party_kind = p_kind and w.party_id = p_party
              and coalesce(w.workspace_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(p_workspace, '00000000-0000-0000-0000-000000000000'::uuid)
              and w.status in ('reserved', 'unknown')) then
    return jsonb_build_object('status', 'in_flight');
  end if;
  v_account := case when p_kind = 'owner' then 'owner_payable' else 'vendor_payable' end;
  v_ws := case when p_kind = 'owner' then p_workspace else null end;
  select b.owed, b.matured, b.pending into v_owed, v_matured, v_pending from public.party_balance(v_account, p_party, v_ws) b;
  v_available := greatest(0, least(v_owed, v_matured) - greatest(p_reserve, 0));
  if p_amount > v_available then
    return jsonb_build_object('status', 'insufficient', 'available', v_available, 'owed', v_owed, 'pending', v_pending);
  end if;
  insert into public.party_withdrawals (party_kind, party_id, workspace_id, amount_cents, destination_account_id, idempotency_key, source)
    values (p_kind, p_party, v_ws, p_amount, p_destination, p_key, p_source) returning id into v_id;
  perform public.post_party_journal(v_ws, 'withdrawal_reserve', 'wd:' || v_id::text || ':reserve', 'party_withdrawal', v_id::text, null,
    jsonb_build_object('party_kind', p_kind, 'party_id', p_party, 'amount_cents', p_amount),
    jsonb_build_array(
      jsonb_build_object('account', v_account, 'party_id', p_party, 'workspace_id', v_ws, 'amount_cents', p_amount),
      jsonb_build_object('account', 'withdrawal_in_flight', 'party_id', p_party, 'workspace_id', v_ws, 'amount_cents', -p_amount)));
  return jsonb_build_object('status', 'reserved', 'withdrawal_id', v_id, 'available_before', v_available);
end;
$$;

create or replace function public.complete_party_withdrawal(p_id uuid, p_transfer text, p_payout text, p_payout_error text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare w public.party_withdrawals%rowtype;
begin
  select * into w from public.party_withdrawals where id = p_id for update;
  if not found then return jsonb_build_object('status', 'refused', 'reason', 'not_found'); end if;
  if w.status = 'completed' then
    update public.party_withdrawals set stripe_payout_id = coalesce(stripe_payout_id, p_payout), payout_error = case when p_payout is not null then null else coalesce(p_payout_error, payout_error) end, updated_at = now() where id = p_id;
    return jsonb_build_object('status', 'exists');
  end if;
  if w.status = 'failed' or p_transfer is null or length(p_transfer) < 4 then return jsonb_build_object('status', 'refused', 'reason', 'bad_state'); end if;
  perform public.post_party_journal(w.workspace_id, 'withdrawal_complete', 'wd:' || p_id::text || ':complete', 'party_withdrawal', p_id::text, p_transfer,
    jsonb_build_object('party_kind', w.party_kind, 'party_id', w.party_id, 'amount_cents', w.amount_cents),
    jsonb_build_array(
      jsonb_build_object('account', 'withdrawal_in_flight', 'party_id', w.party_id, 'workspace_id', w.workspace_id, 'amount_cents', w.amount_cents),
      jsonb_build_object('account', 'platform_cash', 'amount_cents', -w.amount_cents)));
  update public.party_withdrawals set status = 'completed', stripe_transfer_id = p_transfer, stripe_payout_id = p_payout,
    payout_error = p_payout_error, completed_at = now(), updated_at = now() where id = p_id;
  return jsonb_build_object('status', 'completed');
end;
$$;

create or replace function public.fail_party_withdrawal(p_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare w public.party_withdrawals%rowtype; v_account text;
begin
  select * into w from public.party_withdrawals where id = p_id for update;
  if not found then return jsonb_build_object('status', 'refused', 'reason', 'not_found'); end if;
  if w.status = 'failed' then return jsonb_build_object('status', 'exists'); end if;
  if w.status = 'completed' then return jsonb_build_object('status', 'refused', 'reason', 'already_completed'); end if;
  v_account := case when w.party_kind = 'owner' then 'owner_payable' else 'vendor_payable' end;
  perform public.post_party_journal(w.workspace_id, 'withdrawal_failed', 'wd:' || p_id::text || ':fail', 'party_withdrawal', p_id::text, null,
    jsonb_build_object('reason', left(coalesce(p_reason, ''), 200)),
    jsonb_build_array(
      jsonb_build_object('account', 'withdrawal_in_flight', 'party_id', w.party_id, 'workspace_id', w.workspace_id, 'amount_cents', w.amount_cents),
      jsonb_build_object('account', v_account, 'party_id', w.party_id, 'workspace_id', w.workspace_id, 'amount_cents', -w.amount_cents)));
  update public.party_withdrawals set status = 'failed', failure_reason = left(coalesce(p_reason, ''), 300), updated_at = now() where id = p_id;
  return jsonb_build_object('status', 'failed');
end;
$$;

create or replace function public.mark_party_withdrawal_unknown(p_id uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.party_withdrawals set status = 'unknown', updated_at = now() where id = p_id and status = 'reserved';
  return found;
end;
$$;


-- ---------------------------------------------------------------------------------------------
-- activate_managed_policy: accept a draft (owner signature or admin attestation), ending the workspace's previous active
-- version in the same transaction so a workspace is never left unmanaged between them.
-- ---------------------------------------------------------------------------------------------
create or replace function public.activate_managed_policy(
  p_id uuid, p_via text, p_note text, p_hash text, p_snapshot jsonb, p_actor_role text
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_pol public.managed_workspace_fee_policies%rowtype;
begin
  if p_via not in ('owner_signature', 'admin_attested') or p_actor_role not in ('admin', 'owner', 'system') then
    return jsonb_build_object('status', 'refused', 'reason', 'bad_request');
  end if;
  select * into v_pol from public.managed_workspace_fee_policies where id = p_id for update;
  if not found then return jsonb_build_object('status', 'refused', 'reason', 'not_found'); end if;
  if v_pol.status = 'active' and v_pol.signed_at is not null then return jsonb_build_object('status', 'exists'); end if;
  if v_pol.status <> 'draft' then return jsonb_build_object('status', 'refused', 'reason', 'not_draft'); end if;
  if v_pol.effective_from > current_date then return jsonb_build_object('status', 'refused', 'reason', 'future_effective_from'); end if;
  update public.managed_workspace_fee_policies
    set status = 'ended', ended_at = now(), ended_by_role = 'system', ends_on = greatest(current_date, effective_from), updated_at = now()
    where workspace_id = v_pol.workspace_id and status = 'active' and id <> p_id;
  update public.managed_workspace_fee_policies
    set status = 'active', signed_at = now(), accepted_via = p_via, attestation_note = nullif(trim(coalesce(p_note, '')), ''),
        terms_sha256 = p_hash, terms_snapshot = p_snapshot, updated_at = now()
    where id = p_id;
  return jsonb_build_object('status', 'active');
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Platform views for the admin Property management half and the daily reconciliation.
-- ---------------------------------------------------------------------------------------------
create or replace function public.platform_ledger_totals()
returns table (account text, total bigint, matured bigint)
language sql stable security definer set search_path = public, pg_temp as $$
  select l.account,
         coalesce(sum(l.amount_cents), 0)::bigint,
         coalesce(sum(l.amount_cents) filter (where l.available_on is null or l.available_on <= now()), 0)::bigint
    from public.party_ledger_lines l
   group by l.account;
$$;

create or replace function public.platform_fee_revenue_by_month()
returns table (workspace_id uuid, month_key text, revenue_cents bigint)
language sql stable security definer set search_path = public, pg_temp as $$
  select l.workspace_id,
         to_char(j.posted_at at time zone 'America/Los_Angeles', 'YYYY-MM'),
         coalesce(-sum(l.amount_cents), 0)::bigint
    from public.party_ledger_lines l
    join public.party_ledger_journals j on j.id = l.journal_id
   where l.account = 'proplane_fee_revenue'
   group by l.workspace_id, to_char(j.posted_at at time zone 'America/Los_Angeles', 'YYYY-MM');
$$;

-- Unbalanced journals (should be none: a deferred trigger enforces it); a standing check for the daily reconciliation.
create or replace function public.party_ledger_unbalanced_journals()
returns table (journal_id uuid, total bigint)
language sql stable security definer set search_path = public, pg_temp as $$
  select l.journal_id, sum(l.amount_cents)::bigint
    from public.party_ledger_lines l
   group by l.journal_id
  having sum(l.amount_cents) <> 0
   limit 50;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'post_party_journal(uuid, text, text, text, text, text, jsonb, jsonb, timestamptz)',
    'party_balance(text, text, uuid)',
    'managed_month_totals(uuid, text)',
    'credit_managed_capture(uuid, uuid, text, text, text, text, timestamptz, bigint, bigint, bigint, jsonb)',
    'apply_managed_refund(uuid, text, bigint, timestamptz)',
    'apply_managed_dispute(text, text, text, bigint, bigint)',
    'reserve_party_withdrawal(text, text, uuid, bigint, text, text, bigint, text)',
    'complete_party_withdrawal(uuid, text, text, text)',
    'fail_party_withdrawal(uuid, text)',
    'mark_party_withdrawal_unknown(uuid)',
    'activate_managed_policy(uuid, text, text, text, jsonb, text)',
    'platform_ledger_totals()',
    'platform_fee_revenue_by_month()',
    'party_ledger_unbalanced_journals()'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
