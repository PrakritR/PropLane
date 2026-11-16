-- Payout splits (Airbnb co-host style) on PropLane-managed workspaces, payout holds, and staff payout audit.
-- Additive and idempotent. docs/agents/owner-management.md § Payouts and splits.
--
-- Money rules:
--  * A split moves a share of the OWNER's share of a settled payment to a team member's own party (or a vendor's payable) through
--    one balanced journal in the existing party ledger. No money moves at Stripe until that person withdraws.
--  * Every table here is service-role written only: RLS on, every client privilege revoked. Writes go through routes that pin
--    the actor to the authenticated platform admin / person.
--  * Rules are effective-dated and never edited in place (a change ends the old row and adds a new one), so history is never rewritten.

-- 1. New journal kinds.
alter table public.party_ledger_journals drop constraint if exists party_ledger_journals_kind_check;
alter table public.party_ledger_journals add constraint party_ledger_journals_kind_check check (kind in (
  'rent_capture', 'refund', 'dispute_opened', 'dispute_won', 'dispute_lost', 'vendor_bill', 'vendor_bill_reversal',
  'withdrawal_reserve', 'withdrawal_complete', 'withdrawal_failed', 'adjustment', 'directory_claim',
  'split_allocation', 'split_reversal'
));

-- 2. Split rules (one row per payee per rule; per-house override when property_id is set).
create table if not exists public.managed_split_rules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.portal_workspaces (id) on delete cascade,
  property_id text,
  rule_kind text not null check (rule_kind in ('percent', 'fixed')),
  -- The charge kinds the rule applies to (rent and stay kinds by default; validated in code against an allowlist).
  applies_to text[] not null default array['rent', 'first_month_rent', 'prorated_rent', 'prorated_last_month_rent', 'stay_total']::text[],
  payee_kind text not null check (payee_kind in ('member', 'vendor')),
  payee_user_id uuid not null references auth.users (id) on delete cascade,
  bps integer check (bps is null or (bps > 0 and bps <= 10000)),
  fixed_cents bigint check (fixed_cents is null or (fixed_cents > 0 and fixed_cents <= 100000000)),
  effective_from timestamptz not null default now(),
  ended_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  ended_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint managed_split_rules_shape check (
    (rule_kind = 'percent' and bps is not null and fixed_cents is null)
    or (rule_kind = 'fixed' and fixed_cents is not null and bps is null)
  ),
  constraint managed_split_rules_window check (ended_at is null or ended_at >= effective_from)
);
create index if not exists managed_split_rules_workspace_idx on public.managed_split_rules (workspace_id, effective_from desc);
create index if not exists managed_split_rules_payee_idx on public.managed_split_rules (payee_user_id);

-- A rule's terms never change after the insert; only `ended_at` / `ended_by` may be set, once.
create or replace function public.managed_split_rules_immutable()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    return old;
  end if;
  if (to_jsonb(new) - 'ended_at' - 'ended_by') <> (to_jsonb(old) - 'ended_at' - 'ended_by') then
    raise exception 'A split rule cannot be edited; end it and add a new one.';
  end if;
  if old.ended_at is not null and (new.ended_at is distinct from old.ended_at) then
    raise exception 'A split rule can only be ended once.';
  end if;
  return new;
end;
$$;
drop trigger if exists managed_split_rules_immutable on public.managed_split_rules;
create trigger managed_split_rules_immutable
  before update on public.managed_split_rules
  for each row execute function public.managed_split_rules_immutable();

-- 3. What each rule paid out of each payment (the audit trail and the basis of pro-rata refund reversal).
create table if not exists public.managed_split_allocations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.portal_workspaces (id) on delete cascade,
  allocation_id uuid not null references public.managed_rent_allocations (id) on delete cascade,
  rule_id uuid references public.managed_split_rules (id) on delete set null,
  payee_kind text not null check (payee_kind in ('member', 'vendor')),
  payee_user_id uuid references auth.users (id) on delete set null,
  payee_party text not null,
  stripe_payment_intent_id text not null,
  charge_id text not null,
  property_id text,
  amount_cents bigint not null check (amount_cents > 0),
  reversed_cents bigint not null default 0 check (reversed_cents >= 0 and reversed_cents <= amount_cents),
  journal_id uuid references public.party_ledger_journals (id) on delete set null,
  available_on timestamptz,
  paid_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint managed_split_alloc_once unique (allocation_id, rule_id)
);
create index if not exists managed_split_alloc_workspace_idx on public.managed_split_allocations (workspace_id, paid_at desc);
create index if not exists managed_split_alloc_payee_idx on public.managed_split_allocations (payee_user_id, workspace_id);
create index if not exists managed_split_alloc_allocation_idx on public.managed_split_allocations (allocation_id);

-- 4. Payout holds: staff can hold one party's withdrawals (never their balance) with a reason; release is a second audited action.
create table if not exists public.managed_payout_holds (
  id uuid primary key default gen_random_uuid(),
  party_id text not null,
  workspace_id uuid references public.portal_workspaces (id) on delete cascade,
  reason text not null check (length(trim(reason)) between 3 and 500),
  placed_by uuid references auth.users (id) on delete set null,
  placed_at timestamptz not null default now(),
  released_by uuid references auth.users (id) on delete set null,
  released_at timestamptz,
  release_note text
);
create unique index if not exists managed_payout_holds_one_active
  on public.managed_payout_holds (party_id, coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where released_at is null;
create index if not exists managed_payout_holds_party_idx on public.managed_payout_holds (party_id);

-- 5. Append-only staff audit for everything on the Admin Payouts page and the split editor.
create table if not exists public.payout_staff_actions (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references auth.users (id) on delete set null,
  action text not null check (action in (
    'hold', 'release', 'retry_check', 'split_rule_created', 'split_rule_ended', 'bill_threshold_set'
  )),
  workspace_id uuid references public.portal_workspaces (id) on delete set null,
  party_id text,
  subject_id text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists payout_staff_actions_workspace_idx on public.payout_staff_actions (workspace_id, created_at desc);

create or replace function public.payout_staff_actions_append_only()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and old.actor_user_id is not null and new.actor_user_id is null
     and (to_jsonb(new) - 'actor_user_id') = (to_jsonb(old) - 'actor_user_id') then
    return new; -- a deleted actor detaches itself (the foreign key's `on delete set null`)
  end if;
  if tg_op = 'UPDATE' and old.workspace_id is not null and new.workspace_id is null
     and (to_jsonb(new) - 'workspace_id') = (to_jsonb(old) - 'workspace_id') then
    return new;
  end if;
  raise exception 'The payout audit is append-only.';
end;
$$;
drop trigger if exists payout_staff_actions_append_only on public.payout_staff_actions;
create trigger payout_staff_actions_append_only
  before update or delete on public.payout_staff_actions
  for each row execute function public.payout_staff_actions_append_only();

-- 6. Bill pay: the per-workspace approval threshold (default $500). Above it, the bill waits for the owner / admin.
create table if not exists public.managed_payout_settings (
  workspace_id uuid primary key references public.portal_workspaces (id) on delete cascade,
  bill_approval_threshold_cents bigint not null default 50000 check (bill_approval_threshold_cents >= 0 and bill_approval_threshold_cents <= 100000000),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

-- RLS on, no client access of any kind: Supabase's default privileges hand anon/authenticated every right on a new table.
alter table public.managed_split_rules enable row level security;
alter table public.managed_split_allocations enable row level security;
alter table public.managed_payout_holds enable row level security;
alter table public.payout_staff_actions enable row level security;
alter table public.managed_payout_settings enable row level security;
revoke all on public.managed_split_rules from anon, authenticated;
revoke all on public.managed_split_allocations from anon, authenticated;
revoke all on public.managed_payout_holds from anon, authenticated;
revoke all on public.payout_staff_actions from anon, authenticated;
revoke all on public.managed_payout_settings from anon, authenticated;
