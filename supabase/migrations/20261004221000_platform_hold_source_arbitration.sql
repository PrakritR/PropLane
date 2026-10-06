-- Source-backed platform holds. Existing rows keep their visible status and
-- balance, but have no release authority until their actual Stripe charge and
-- refund history are verified. All provider operations reserve under the hold
-- lock before an external call; an unknown outcome keeps its reservation.
alter table public.platform_payment_holds
  add column if not exists original_amount_cents integer,
  add column if not exists source_principal_cents integer,
  add column if not exists source_fee_payer text,
  add column if not exists source_allocation_mode text,
  add column if not exists source_charge_gross_cents integer,
  add column if not exists source_payment_intent_id text,
  add column if not exists source_destination_account_id text,
  add column if not exists source_transfer_gross_cents integer,
  add column if not exists source_application_fee_cents integer,
  add column if not exists source_application_fee_id text,
  add column if not exists source_components jsonb,
  add column if not exists source_verified_at timestamptz;

-- Account deletion detaches identity while retaining exact financial source
-- and refund history. The preservation runner NULLs owner IDs before deleting
-- auth.users; a cascading FK or NOT NULL column would erase/strand the money.
alter table public.platform_payment_holds alter column owner_user_id drop not null;
alter table public.platform_payment_holds drop constraint if exists platform_payment_holds_owner_user_id_fkey;
alter table public.platform_payment_holds add constraint platform_payment_holds_owner_user_id_fkey
  foreign key(owner_user_id) references auth.users(id) on delete set null;

alter table public.platform_payment_holds drop constraint if exists platform_payment_holds_amount_cents_check;
-- Legacy workers scan status='held' and send a transfer before their CAS.
-- Only newly verified central sources use this internal state; historical
-- holds retain their original status and replay economics.
alter table public.platform_payment_holds drop constraint if exists platform_payment_holds_status_check;
alter table public.platform_payment_holds add constraint platform_payment_holds_status_check
  check (status in ('held','classified_held','transferred','refunded'));
alter table public.platform_payment_holds drop constraint if exists platform_hold_remaining_amount_check;
alter table public.platform_payment_holds add constraint platform_hold_remaining_amount_check check (amount_cents >= 0);

alter table public.platform_payment_holds drop constraint if exists platform_hold_source_amount_check;
alter table public.platform_payment_holds add constraint platform_hold_source_amount_check
  check (original_amount_cents is null or
         (original_amount_cents > 0 and amount_cents >= 0 and amount_cents <= original_amount_cents));
alter table public.platform_payment_holds drop constraint if exists platform_hold_source_gross_check;
alter table public.platform_payment_holds add constraint platform_hold_source_gross_check
  check (source_charge_gross_cents is null or
         (source_principal_cents > 0 and source_charge_gross_cents >= source_principal_cents and
          original_amount_cents <= source_principal_cents));
alter table public.platform_payment_holds drop constraint if exists platform_hold_source_fee_payer_check;
alter table public.platform_payment_holds add constraint platform_hold_source_fee_payer_check
  check (source_fee_payer is null or source_fee_payer in ('resident','manager','proplane','vendor'));
alter table public.platform_payment_holds drop constraint if exists platform_hold_allocation_mode_check;
alter table public.platform_payment_holds add constraint platform_hold_allocation_mode_check
  check (source_allocation_mode is null or source_allocation_mode in ('hold','destination'));
alter table public.platform_payment_holds drop constraint if exists platform_hold_source_complete_check;
alter table public.platform_payment_holds add constraint platform_hold_source_complete_check
  check (source_verified_at is null or
         (original_amount_cents is not null and original_amount_cents > 0 and
          source_principal_cents is not null and source_principal_cents > 0 and
          source_charge_gross_cents is not null and source_charge_gross_cents >= source_principal_cents and
          source_fee_payer is not null and
          nullif(trim(source_payment_intent_id),'') is not null and
          nullif(trim(stripe_charge_id),'') is not null and
          source_allocation_mode is not null and source_components is not null and
          jsonb_typeof(source_components)='array' and jsonb_array_length(source_components)>0 and
          (source_allocation_mode='hold' or
           (source_allocation_mode='destination' and status in ('transferred','refunded') and
            nullif(trim(source_destination_account_id),'') is not null and
            source_transfer_gross_cents is not null and source_application_fee_cents is not null and
            nullif(trim(stripe_transfer_id),'') is not null))));
-- Checkout and PaymentIntent webhooks refer to the same captured payment.
-- One aggregate allocation per canonical PI keeps a mixed cart's recipient
-- principal from being credited again under a second webhook source id.
create unique index if not exists platform_hold_verified_payment_intent_unique
  on public.platform_payment_holds(source_payment_intent_id)
  where source_payment_intent_id is not null;

-- Exact provider refund evidence can arrive before source credit or while a
-- transfer response is unknown. It blocks fresh credit/release under the same
-- charge advisory lock; failed/canceled evidence remains for audit but does
-- not imply money moved. Opaque provider IDs are retained for reconciliation.
create table if not exists public.platform_source_refund_evidence (
  stripe_refund_id text primary key,
  stripe_charge_id text not null,
  stripe_payment_intent_id text,
  amount_cents integer not null check (amount_cents > 0),
  status text not null check (status in ('pending','succeeded','failed','canceled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists platform_source_refund_evidence_charge_idx
  on public.platform_source_refund_evidence(stripe_charge_id,status);
alter table public.platform_source_refund_evidence enable row level security;
revoke all on public.platform_source_refund_evidence from public,anon,authenticated;
grant all on public.platform_source_refund_evidence to service_role;

create or replace function public.record_platform_source_refund_evidence(
  p_refund text,p_charge text,p_payment_intent text,p_amount integer,p_status text
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare prior public.platform_source_refund_evidence;
begin
  if nullif(trim(p_refund),'') is null or nullif(trim(p_charge),'') is null or
     p_amount is null or p_amount<=0 or p_status is null or
     p_status not in ('pending','succeeded','failed','canceled') then
    raise exception 'refund evidence is incomplete';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('platform-source-charge:'||p_charge,0));
  select * into prior from public.platform_source_refund_evidence
    where stripe_refund_id=p_refund for update;
  if found then
    if prior.stripe_charge_id is distinct from p_charge or
       (prior.stripe_payment_intent_id is not null and p_payment_intent is not null and
        prior.stripe_payment_intent_id is distinct from p_payment_intent) or
       prior.amount_cents is distinct from p_amount or
       (prior.status in ('succeeded','failed','canceled') and prior.status is distinct from p_status
        and p_status<>'pending') or
       (prior.status='pending' and p_status not in ('pending','succeeded','failed','canceled')) then
      raise exception 'refund evidence changed immutable source or terminal result';
    end if;
    if prior.status in ('succeeded','failed','canceled') and p_status='pending' then return false; end if;
    if prior.status=p_status and
       (prior.stripe_payment_intent_id is not null or p_payment_intent is null) then return false; end if;
    update public.platform_source_refund_evidence set status=p_status,
      stripe_payment_intent_id=coalesce(stripe_payment_intent_id,p_payment_intent),updated_at=now()
      where stripe_refund_id=p_refund;
    return true;
  end if;
  insert into public.platform_source_refund_evidence
    (stripe_refund_id,stripe_charge_id,stripe_payment_intent_id,amount_cents,status)
    values(p_refund,p_charge,p_payment_intent,p_amount,p_status);
  return true;
end $$;

-- A direct invoice can also name a service, so work_order_id/invoice_id alone
-- cannot say which hold funded its payout. The verified settlement stamps the
-- exact source row; legacy unstamped payouts require reconciliation.
alter table public.vendor_payouts
  add column if not exists platform_hold_id uuid references public.platform_payment_holds(id);

create table if not exists public.platform_hold_transfer_attempts (
  id uuid primary key default gen_random_uuid(),
  hold_id uuid not null references public.platform_payment_holds(id) on delete cascade,
  attempt_key text not null unique,
  owner_user_id uuid references auth.users(id) on delete set null,
  destination_account_id text not null,
  source_charge_id text not null,
  amount_cents integer not null check (amount_cents > 0),
  component_breakdown jsonb not null,
  status text not null check (status in ('reserved','created','failed')),
  stripe_transfer_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop index if exists public.platform_hold_transfer_one_active;
-- A source can have several immutable completed transfers when an owner-debt
-- reservation later becomes releasable. Only one provider-unknown reservation
-- may exist at a time; each completed leg keeps its own exact Stripe ID.
create unique index platform_hold_transfer_one_active
  on public.platform_hold_transfer_attempts(hold_id)
  where status='reserved';
alter table public.platform_hold_transfer_attempts
  add column if not exists component_breakdown jsonb;

create table if not exists public.platform_hold_refund_attempts (
  id uuid primary key default gen_random_uuid(),
  hold_id uuid references public.platform_payment_holds(id) on delete cascade,
  payout_id uuid references public.vendor_payouts(id) on delete cascade,
  attempt_key text not null unique,
  owner_user_id uuid references auth.users(id) on delete set null,
  gross_cents integer not null check (gross_cents > 0),
  principal_cents integer not null check (principal_cents > 0 and principal_cents <= gross_cents),
  refund_components jsonb,
  recipient_debit_components jsonb,
  source_charge_id text not null,
  currency text not null default 'usd' check (currency='usd'),
  provider_reason text not null check (provider_reason in ('requested_by_customer','duplicate','fraudulent')),
  reverse_transfer boolean not null default false,
  refund_application_fee boolean not null default false,
  fee_share_cents integer not null default 0 check (fee_share_cents >= 0),
  hold_debit_cents integer not null default 0 check (hold_debit_cents >= 0),
  held_cash_debit_cents integer not null default 0 check (held_cash_debit_cents >= 0),
  held_cash_debit_components jsonb,
  transfer_reversal_cents integer not null default 0 check (transfer_reversal_cents >= 0),
  manager_debt_cents integer not null default 0 check (manager_debt_cents >= 0),
  funded_debt_cents integer not null default 0 check (funded_debt_cents >= 0),
  recovered_cents integer not null default 0 check (recovered_cents >= 0 and recovered_cents <= funded_debt_cents),
  refunded_at timestamptz,
  reversal_created_at timestamptz,
  settlement_allocation_mode text check (settlement_allocation_mode in ('held','transferred','mixed')),
  status text not null check (status in ('reserved','succeeded','failed')),
  stripe_refund_id text unique,
  terminal_provider_status text check (terminal_provider_status in ('failed','canceled')),
  stripe_reversal_id text unique,
  reversal_status text check (reversal_status in ('not_required','pending','succeeded','shortfall')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (hold_id is not null or payout_id is not null)
);

-- A payer refund can require recovery from several earlier exact transfers.
-- The attempt's scalar reversal columns remain a one-leg historical mirror;
-- these rows freeze the new per-transfer recipient NET and component vector
-- before any provider reversal is requested.
create table if not exists public.platform_hold_refund_transfer_legs (
  id uuid primary key default gen_random_uuid(),
  refund_attempt_id uuid not null references public.platform_hold_refund_attempts(id) on delete cascade,
  transfer_attempt_id uuid not null references public.platform_hold_transfer_attempts(id) on delete cascade,
  hold_id uuid not null references public.platform_payment_holds(id) on delete cascade,
  owner_user_id uuid references auth.users(id) on delete set null,
  source_charge_id text not null check (nullif(trim(source_charge_id),'') is not null),
  source_transfer_id text not null check (nullif(trim(source_transfer_id),'') is not null),
  amount_cents integer not null check (amount_cents > 0),
  component_breakdown jsonb not null check
    (jsonb_typeof(component_breakdown)='array' and jsonb_array_length(component_breakdown)>0),
  status text not null check (status in ('reserved','created','failed')),
  stripe_reversal_id text unique,
  reversed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(refund_attempt_id,transfer_attempt_id)
);
alter table public.platform_hold_refund_transfer_legs
  add column if not exists reversed_at timestamptz;
create index if not exists platform_refund_transfer_legs_source_idx
  on public.platform_hold_refund_transfer_legs(transfer_attempt_id,status);
alter table public.platform_hold_refund_transfer_legs enable row level security;
revoke all on public.platform_hold_refund_transfer_legs from public,anon,authenticated;
grant all on public.platform_hold_refund_transfer_legs to service_role;

-- A recipient's internal spend, withdrawal or same-owner debt recovery
-- consumes captured component NET. The vendor's earned payout is a derived
-- claim on this source, never another credit for the same PaymentIntent.
-- These rows are inert until the wallet/money writers settle them in the
-- same transaction as their existing ledger move or transfer reservation.
create table if not exists public.platform_source_consumption_legs (
  id uuid primary key default gen_random_uuid(),
  hold_id uuid not null references public.platform_payment_holds(id) on delete cascade,
  source_component_id text not null check (nullif(trim(source_component_id),'') is not null),
  owner_user_id uuid references auth.users(id) on delete set null,
  kind text not null check (kind in ('vendor_payment','owner_withdrawal','owner_debt_recovery')),
  source_net_cents integer not null check (source_net_cents > 0),
  beneficiary_user_id uuid references auth.users(id) on delete set null,
  beneficiary_identity_detached boolean not null default false,
  beneficiary_principal_cents integer check (beneficiary_principal_cents >= 0),
  beneficiary_net_cents integer check (beneficiary_net_cents >= 0),
  vendor_fee_cents integer check (vendor_fee_cents >= 0),
  wallet_debit_entry_id uuid references public.proplane_balance_entries(id) on delete cascade,
  wallet_credit_entry_id uuid references public.proplane_balance_entries(id) on delete cascade,
  payout_id uuid references public.vendor_payouts(id) on delete set null,
  provider_transfer_id text unique,
  creditor_refund_attempt_id uuid references public.platform_hold_refund_attempts(id) on delete cascade,
  source_charge_id text,
  source_payment_intent_id text,
  source_balance_transaction_id text,
  source_available_on timestamptz,
  source_attested_at timestamptz,
  recovery_journal_id uuid,
  recovered_at timestamptz,
  predecessor_leg_id uuid references public.platform_source_consumption_legs(id) on delete set null,
  replacement_refund_attempt_id uuid references public.platform_hold_refund_attempts(id) on delete set null,
  attempt_key text not null unique check (nullif(trim(attempt_key),'') is not null),
  status text not null check (status in ('reserved','settled','failed','superseded')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (kind <> 'vendor_payment' or
    ((beneficiary_user_id is not null or beneficiary_identity_detached) and
     beneficiary_principal_cents is not null and
     beneficiary_net_cents is not null and vendor_fee_cents is not null and
     beneficiary_principal_cents - beneficiary_net_cents = vendor_fee_cents)),
  check (kind <> 'owner_debt_recovery' or
    (creditor_refund_attempt_id is not null and
     nullif(trim(source_charge_id),'') is not null and
     nullif(trim(source_payment_intent_id),'') is not null)),
  check (status <> 'settled' or
    ((wallet_debit_entry_id is not null or kind='owner_debt_recovery') and
     (kind <> 'vendor_payment' or wallet_credit_entry_id is not null) and
     (kind <> 'owner_withdrawal' or provider_transfer_id is not null) and
     (kind <> 'owner_debt_recovery' or
       (source_balance_transaction_id is not null and source_available_on is not null and
        source_attested_at is not null and recovered_at is not null and recovery_journal_id is not null))))
);
create index if not exists platform_source_consumption_source_idx
  on public.platform_source_consumption_legs(hold_id,source_component_id,status);
alter table public.platform_hold_transfer_attempts alter column owner_user_id drop not null;
alter table public.platform_hold_transfer_attempts drop constraint if exists platform_hold_transfer_attempts_owner_user_id_fkey;
alter table public.platform_hold_transfer_attempts add constraint platform_hold_transfer_attempts_owner_user_id_fkey
  foreign key(owner_user_id) references auth.users(id) on delete set null;
alter table public.platform_hold_refund_attempts alter column owner_user_id drop not null;
alter table public.platform_hold_refund_attempts drop constraint if exists platform_hold_refund_attempts_owner_user_id_fkey;
alter table public.platform_hold_refund_attempts add constraint platform_hold_refund_attempts_owner_user_id_fkey
  foreign key(owner_user_id) references auth.users(id) on delete set null;
alter table public.platform_source_consumption_legs alter column owner_user_id drop not null;
alter table public.platform_source_consumption_legs drop constraint if exists platform_source_consumption_legs_owner_user_id_fkey;
alter table public.platform_source_consumption_legs add constraint platform_source_consumption_legs_owner_user_id_fkey
  foreign key(owner_user_id) references auth.users(id) on delete set null;
alter table public.platform_source_consumption_legs drop constraint if exists platform_source_consumption_legs_beneficiary_user_id_fkey;
alter table public.platform_source_consumption_legs add constraint platform_source_consumption_legs_beneficiary_user_id_fkey
  foreign key(beneficiary_user_id) references auth.users(id) on delete set null;
alter table public.platform_source_consumption_legs
  add column if not exists beneficiary_identity_detached boolean not null default false;
alter table public.platform_source_consumption_legs
  add column if not exists source_charge_id text,
  add column if not exists source_payment_intent_id text,
  add column if not exists source_balance_transaction_id text,
  add column if not exists source_available_on timestamptz,
  add column if not exists source_attested_at timestamptz,
  add column if not exists recovery_journal_id uuid,
  add column if not exists recovered_at timestamptz,
  add column if not exists predecessor_leg_id uuid references public.platform_source_consumption_legs(id) on delete set null,
  add column if not exists replacement_refund_attempt_id uuid references public.platform_hold_refund_attempts(id) on delete set null;
-- Financial history is intentionally retained when an account is purged,
-- while its owned GL rows are removed. Keep the immutable journal ID as
-- historical evidence without an FK that would null it and violate the
-- settled-source proof constraint during that deletion.
alter table public.platform_source_consumption_legs
  drop constraint if exists platform_source_consumption_legs_recovery_journal_id_fkey;
alter table public.platform_source_consumption_legs drop constraint if exists platform_source_consumption_legs_status_check;
alter table public.platform_source_consumption_legs add constraint platform_source_consumption_legs_status_check
  check (status in ('reserved','settled','failed','superseded'));
alter table public.platform_source_consumption_legs
  drop constraint if exists platform_source_consumption_legs_check2;
alter table public.platform_source_consumption_legs
  drop constraint if exists platform_source_consumption_legs_settled_wallet_check;
alter table public.platform_source_consumption_legs
  add constraint platform_source_consumption_legs_settled_wallet_check check
    (status <> 'settled' or kind='owner_debt_recovery' or
     (wallet_debit_entry_id is not null and
      (kind <> 'vendor_payment' or wallet_credit_entry_id is not null) and
      (kind <> 'owner_withdrawal' or provider_transfer_id is not null)));
alter table public.platform_source_consumption_legs drop constraint if exists platform_source_consumption_legs_check;
alter table public.platform_source_consumption_legs add constraint platform_source_consumption_legs_check
  check (kind <> 'vendor_payment' or
    ((beneficiary_user_id is not null or beneficiary_identity_detached) and
     beneficiary_principal_cents is not null and beneficiary_net_cents is not null and
     vendor_fee_cents is not null and beneficiary_principal_cents-beneficiary_net_cents=vendor_fee_cents));
create or replace function public.platform_source_consumption_detach_identity()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if tg_op='INSERT' and new.kind='vendor_payment' and new.beneficiary_user_id is null then
    raise exception 'new vendor consumption requires beneficiary identity';
  end if;
  if tg_op='UPDATE' and old.beneficiary_user_id is not null and
     new.beneficiary_user_id is null then
    new.beneficiary_identity_detached:=true;
  end if;
  return new;
end $$;
drop trigger if exists platform_source_consumption_detach_identity on public.platform_source_consumption_legs;
create trigger platform_source_consumption_detach_identity before insert or update
  on public.platform_source_consumption_legs for each row
  execute function public.platform_source_consumption_detach_identity();
alter table public.platform_source_consumption_legs
  drop constraint if exists platform_source_consumption_legs_wallet_debit_entry_id_key;
alter table public.platform_source_consumption_legs
  drop constraint if exists platform_source_consumption_legs_wallet_credit_entry_id_key;
create index if not exists platform_source_consumption_creditor_idx
  on public.platform_source_consumption_legs(creditor_refund_attempt_id,status)
  where creditor_refund_attempt_id is not null;
drop index if exists public.platform_source_owner_recovery_exact_source;
create unique index platform_source_owner_recovery_exact_source
  on public.platform_source_consumption_legs(hold_id,source_component_id,creditor_refund_attempt_id)
  where kind='owner_debt_recovery' and status='reserved';
alter table public.platform_source_consumption_legs drop constraint if exists platform_source_consumption_legs_owner_recovery_check;
alter table public.platform_source_consumption_legs add constraint platform_source_consumption_legs_owner_recovery_check
  check (kind <> 'owner_debt_recovery' or
    (creditor_refund_attempt_id is not null and
     nullif(trim(source_charge_id),'') is not null and
     nullif(trim(source_payment_intent_id),'') is not null));
alter table public.platform_source_consumption_legs drop constraint if exists platform_source_consumption_legs_settled_proof_check;
alter table public.platform_source_consumption_legs add constraint platform_source_consumption_legs_settled_proof_check
  check (status <> 'settled' or kind <> 'owner_debt_recovery' or
    (source_balance_transaction_id is not null and source_available_on is not null and
     source_attested_at is not null and recovered_at is not null and recovery_journal_id is not null));
alter table public.platform_source_consumption_legs enable row level security;
revoke all on public.platform_source_consumption_legs from public,anon,authenticated;
grant all on public.platform_source_consumption_legs to service_role;
-- New classified wallet credits are projections of captured component NET.
-- Historical aggregate entries remain NULL and cannot authorize new source
-- consumption without exact reconciliation. A source component has one mirror.
alter table public.proplane_balance_entries
  add column if not exists source_hold_id uuid references public.platform_payment_holds(id),
  add column if not exists source_component_id text,
  add column if not exists source_liability_class text,
  add column if not exists source_spend_breakdown jsonb,
  add column if not exists source_income_debit_cents integer;
alter table public.proplane_balance_entries drop constraint if exists proplane_balance_source_component_complete;
alter table public.proplane_balance_entries add constraint proplane_balance_source_component_complete check
  ((source_hold_id is null and source_component_id is null and source_liability_class is null) or
   (source_hold_id is not null and nullif(trim(source_component_id),'') is not null and
    source_liability_class in ('income','deposit','vendor') and kind='resident_payment' and amount_cents>0));
create unique index if not exists proplane_balance_component_credit_unique
  on public.proplane_balance_entries(source_hold_id,source_component_id)
  where source_hold_id is not null;
-- The existing account-preservation RPC clears matching identity columns.
-- owner_key is the non-null ledger account key, so detach it to the marker
-- rather than deleting the account and cascading its financial entries.
create or replace function public.proplane_balance_detach_owner_key()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_marker uuid;
begin
  if new.owner_key is null then
    select marker_id into v_marker from public.account_deleted_record_identities
      where table_name='proplane_balance_accounts' and record_id=old.id::text;
    if v_marker is null then raise exception 'balance account detachment marker missing'; end if;
    new.owner_key:='deleted-'||v_marker::text;
  end if;
  return new;
end $$;
drop trigger if exists account_balance_owner_key_detach on public.proplane_balance_accounts;
create trigger account_balance_owner_key_detach before update of owner_key
  on public.proplane_balance_accounts for each row
  execute function public.proplane_balance_detach_owner_key();
-- The existing preservation RPC records hashed former identity keys. The
-- same guard that protects older finance rows prevents later reattachment of
-- a deleted manager/vendor identity to any of these retained source records.
do $$ declare v_table text; begin
  foreach v_table in array array[
    'platform_payment_holds','platform_hold_transfer_attempts',
    'platform_hold_refund_attempts','platform_hold_refund_transfer_legs',
    'platform_source_consumption_legs',
    'proplane_balance_accounts'] loop
    execute format('drop trigger if exists account_guard_deleted_financial_identity on public.%I',v_table);
    execute format('create trigger account_guard_deleted_financial_identity before insert or update on public.%I for each row execute function public.account_guard_deleted_financial_identity()',v_table);
  end loop;
end $$;
alter table public.proplane_balance_entries drop constraint if exists proplane_balance_source_income_debit_check;
alter table public.proplane_balance_entries add constraint proplane_balance_source_income_debit_check check
  (source_income_debit_cents is null or
   (amount_cents<0 and source_spend_breakdown is not null and
    source_income_debit_cents>=0 and source_income_debit_cents<=-amount_cents));
alter table public.platform_hold_refund_attempts
  add column if not exists terminal_provider_status text;
alter table public.platform_hold_refund_attempts
  add column if not exists refund_components jsonb;
alter table public.platform_hold_refund_attempts
  add column if not exists recipient_debit_components jsonb;
alter table public.platform_hold_refund_attempts
  add column if not exists funded_debt_cents integer not null default 0,
  add column if not exists refunded_at timestamptz,
  add column if not exists reversal_created_at timestamptz,
  add column if not exists held_cash_debit_cents integer not null default 0,
  add column if not exists held_cash_debit_components jsonb,
  add column if not exists transfer_reversal_cents integer not null default 0,
  add column if not exists settlement_allocation_mode text
    check (settlement_allocation_mode in ('held','transferred','mixed'));
alter table public.platform_hold_refund_attempts drop constraint if exists platform_hold_refund_attempts_settlement_allocation_mode_check;
alter table public.platform_hold_refund_attempts add constraint platform_hold_refund_attempts_settlement_allocation_mode_check
  check (settlement_allocation_mode is null or settlement_allocation_mode in ('held','transferred','mixed'));
alter table public.platform_hold_refund_attempts drop constraint if exists platform_hold_refund_attempts_recovered_cents_check;
alter table public.platform_hold_refund_attempts add constraint platform_hold_refund_attempts_recovered_cents_check
  check (recovered_cents>=0 and recovered_cents<=funded_debt_cents);
alter table public.platform_hold_refund_attempts drop constraint if exists platform_hold_refund_attempts_funded_debt_cents_check;
alter table public.platform_hold_refund_attempts add constraint platform_hold_refund_attempts_funded_debt_cents_check
  check (funded_debt_cents>=0);
alter table public.platform_hold_refund_attempts
  drop constraint if exists platform_hold_refund_components_check;
alter table public.platform_hold_refund_attempts
  add constraint platform_hold_refund_components_check check
    (refund_components is null or
     (jsonb_typeof(refund_components)='array' and jsonb_array_length(refund_components)>0));
alter table public.platform_hold_refund_attempts
  drop constraint if exists platform_hold_refund_terminal_status_check;
alter table public.platform_hold_refund_attempts
  add constraint platform_hold_refund_terminal_status_check check
    ((status='failed' and stripe_refund_id is not null and terminal_provider_status in ('failed','canceled')) or
     (status<>'failed' and terminal_provider_status is null));
create unique index if not exists platform_hold_refund_one_active_hold
  on public.platform_hold_refund_attempts(hold_id) where hold_id is not null and status='reserved';
create unique index if not exists platform_hold_refund_one_active_payout
  on public.platform_hold_refund_attempts(payout_id) where payout_id is not null and status='reserved';
create index if not exists platform_hold_refund_payout_idx
  on public.platform_hold_refund_attempts(payout_id,status);

-- A succeeded refund already consumed by the exact source allocation is
-- accounted for in its remaining amount. Unknown/pending or external
-- succeeded refunds must block fresh credit/release until reconciled.
create or replace function public.platform_source_has_unmapped_refund(p_charge text)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select exists(select 1 from public.platform_source_refund_evidence e
    where e.stripe_charge_id=p_charge and
      (e.status='pending' or (e.status='succeeded' and not exists(
        select 1 from public.platform_hold_refund_attempts a
        where a.stripe_refund_id=e.stripe_refund_id and
          a.source_charge_id=e.stripe_charge_id and
          a.gross_cents=e.amount_cents and a.status='succeeded'))))
$$;

alter table public.platform_hold_transfer_attempts enable row level security;
alter table public.platform_hold_refund_attempts enable row level security;
revoke all on public.platform_hold_transfer_attempts from public,anon,authenticated;
revoke all on public.platform_hold_refund_attempts from public,anon,authenticated;
grant all on public.platform_hold_transfer_attempts to service_role;
grant all on public.platform_hold_refund_attempts to service_role;

-- Called only after server code has re-read the paid Checkout/PI, succeeded
-- charge, exact beneficiary and zero refunds. A historical hold may receive
-- provenance only while still wholly held and without a refund reservation.
drop function if exists public.verify_platform_hold_source(uuid,uuid,text,text,integer,integer);
drop function if exists public.verify_platform_hold_source(uuid,uuid,text,text,integer,integer,integer,text);
create or replace function public.verify_platform_hold_source(
  p_hold uuid, p_owner uuid, p_charge text, p_payment_intent text,
  p_charge_gross integer, p_principal integer, p_original_net integer,
  p_fee_payer text,p_destination text default null,p_transfer text default null,
  p_transfer_gross integer default null,p_application_fee_cents integer default null,
  p_application_fee_id text default null,p_components jsonb default null
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare h public.platform_payment_holds; components_principal bigint:=0;
  components_net bigint:=0; component_count integer; distinct_sources integer;
  component jsonb; component_kind text; component_class text; component_expected_class text;
begin
  if nullif(trim(p_charge),'') is not null then
    perform pg_advisory_xact_lock(hashtextextended('platform-source-charge:'||p_charge,0));
  end if;
  select * into h from public.platform_payment_holds where id=p_hold for update;
  if not found or p_owner is null or h.owner_user_id is distinct from p_owner or
     h.stripe_charge_id is distinct from p_charge or
     nullif(trim(p_charge),'') is null or nullif(trim(p_payment_intent),'') is null or
     p_charge_gross is null or p_principal is null or p_original_net is null or
     p_charge_gross<=0 or p_principal<=0 or
     p_original_net<=0 or p_original_net>p_principal or p_principal>p_charge_gross or
     p_fee_payer is null or p_fee_payer not in ('resident','manager','proplane','vendor') or
     (h.owner_role='manager' and (
       p_fee_payer='vendor' or
       (p_fee_payer='resident' and p_original_net<>p_principal) or
       (p_fee_payer in ('manager','proplane') and p_charge_gross<>p_principal) or
       (p_fee_payer='proplane' and p_original_net<>p_principal))) or
     -- For a vendor payment, the manager is the funding/processing payer.
     -- The generic Checkout helper calls this `resident`; server settlement
     -- must translate that captured role before attesting the vendor source.
     -- The vendor's separate take rate is P-N, not the processing charge G-P.
     (h.owner_role='vendor' and p_fee_payer<>'manager') or
     (p_destination is null and (p_transfer is not null or p_transfer_gross is not null or
       p_application_fee_cents is not null or p_application_fee_id is not null)) or
     (p_destination is not null and (nullif(trim(p_destination),'') is null or
       nullif(trim(p_transfer),'') is null or p_transfer_gross is null or
       p_application_fee_cents is null or p_application_fee_cents<0 or
       p_transfer_gross<>p_charge_gross or
       p_transfer_gross-p_application_fee_cents<>p_original_net or
       (p_application_fee_cents>0 and nullif(trim(p_application_fee_id),'') is null))) then
    raise exception 'platform hold source cannot be verified';
  end if;
  if p_components is null or jsonb_typeof(p_components)<>'array' then
    raise exception 'platform allocation components are required';
  end if;
  if jsonb_array_length(p_components)=0 then
    raise exception 'platform allocation components are required';
  end if;
  for component in select value from jsonb_array_elements(p_components) as value loop
    if jsonb_typeof(component) is distinct from 'object' or
       jsonb_typeof(component->'source_id') is distinct from 'string' or
       nullif(trim(component->>'source_id'),'') is null or
       jsonb_typeof(component->'kind') is distinct from 'string' or
       jsonb_typeof(component->'liability_class') is distinct from 'string' or
       jsonb_typeof(component->'principal_cents') is distinct from 'number' or
       jsonb_typeof(component->'recipient_net_cents') is distinct from 'number' or
       (component->>'principal_cents') !~ '^[0-9]+$' or
       (component->>'recipient_net_cents') !~ '^[0-9]+$' then
      raise exception 'platform allocation components do not match source amounts';
    end if;
    component_kind:=component->>'kind';
    component_class:=component->>'liability_class';
    -- The class is determined by the captured charge kind. Callers must also
    -- bind each kind/id to the authoritative paid charge or invoice row.
    component_expected_class:=case
         when component_kind in ('security_deposit','holding_deposit') then 'deposit'
         when component_kind in ('vendor_invoice','vendor_service') then 'vendor'
         when component_kind in ('application_fee','stay_total','first_month_rent',
           'prorated_rent','prorated_last_month_rent','rent','utilities',
           'prorated_utilities','prorated_last_month_utilities','prorated_fee',
           'prorated_last_month_fee','early_move_out_fee','move_in_fee','lease_fee',
           'other_cost','payment_at_signing','work_order_charge','late_fee','nsf_fee') then 'income'
         else null end;
    if component_class is distinct from component_expected_class or
       (component->>'principal_cents')::bigint<=0 or
       (component->>'recipient_net_cents')::bigint<0 or
       (component->>'recipient_net_cents')::bigint>(component->>'principal_cents')::bigint then
      raise exception 'platform allocation components do not match source amounts';
    end if;
    components_principal:=components_principal+(component->>'principal_cents')::bigint;
    components_net:=components_net+(component->>'recipient_net_cents')::bigint;
  end loop;
  select count(*)::integer,count(distinct value->>'source_id')::integer
    into component_count,distinct_sources from jsonb_array_elements(p_components) as value;
  if component_count<>distinct_sources or components_principal<>p_principal or
     components_net<>p_original_net then
    raise exception 'platform allocation components do not match source amounts';
  end if;
  if h.source_verified_at is not null then
    if h.original_amount_cents is distinct from p_original_net or
       h.source_principal_cents is distinct from p_principal or
       h.source_fee_payer is distinct from p_fee_payer or
       h.source_charge_gross_cents is distinct from p_charge_gross or
       h.source_payment_intent_id is distinct from p_payment_intent or
       h.source_allocation_mode is distinct from
         (case when p_destination is null then 'hold' else 'destination' end) or
       h.source_destination_account_id is distinct from p_destination or
       h.source_transfer_gross_cents is distinct from p_transfer_gross or
       h.source_application_fee_cents is distinct from p_application_fee_cents or
       h.source_application_fee_id is distinct from p_application_fee_id or
       h.source_components is distinct from p_components or
       (p_destination is not null and h.stripe_transfer_id is distinct from p_transfer) then
      raise exception 'platform hold verified source mismatch';
    end if;
    return false;
  end if;
  if public.platform_source_has_unmapped_refund(p_charge) then
    raise exception 'captured source has unresolved refund evidence';
  end if;
  if (p_destination is null and (h.status not in ('held','classified_held') or h.stripe_transfer_id is not null)) or
     (p_destination is not null and (h.status<>'transferred' or
       h.stripe_transfer_id is distinct from p_transfer)) or
     exists(select 1 from public.platform_hold_refund_attempts where hold_id=p_hold and status<>'failed') then
    raise exception 'platform hold has transfer or refund history';
  end if;
  if h.amount_cents is distinct from p_original_net then raise exception 'platform hold requires source review'; end if;
  update public.platform_payment_holds set original_amount_cents=p_original_net,
    source_principal_cents=p_principal,source_fee_payer=p_fee_payer,
    source_allocation_mode=case when p_destination is null then 'hold' else 'destination' end,
    source_charge_gross_cents=p_charge_gross,source_payment_intent_id=p_payment_intent,
    source_destination_account_id=p_destination,source_transfer_gross_cents=p_transfer_gross,
    source_application_fee_cents=p_application_fee_cents,
    source_application_fee_id=p_application_fee_id,
    source_components=p_components,
    source_verified_at=now(),updated_at=now() where id=p_hold;
  return true;
end $$;

-- New paid sources enter the visible hold balance only after canonical PI
-- arbitration and source verification succeed in the same transaction. The
-- Checkout and PI webhooks can name the same capture, but cannot each credit
-- it. A cart supplies one aggregate allocation with its immutable components.
drop function if exists public.credit_verified_platform_hold(uuid,text,text,text,text,text,integer,integer,integer,text,jsonb);
create or replace function public.credit_verified_platform_hold(
  p_owner uuid,p_owner_role text,p_source text,p_source_id text,
  p_charge text,p_payment_intent text,p_charge_gross integer,
  p_principal integer,p_original_net integer,p_fee_payer text,p_components jsonb,
  p_destination text default null,p_transfer text default null,
  p_transfer_gross integer default null,p_application_fee_cents integer default null,
  p_application_fee_id text default null
) returns table(hold_id uuid,credited boolean)
language plpgsql security definer set search_path=public,pg_temp as $$
declare h public.platform_payment_holds; v_created boolean:=false;
begin
  if p_owner is null or p_owner_role is null or
     nullif(trim(p_source),'') is null or nullif(trim(p_source_id),'') is null or
     nullif(trim(p_charge),'') is null or
     nullif(trim(p_payment_intent),'') is null then
    raise exception 'verified platform hold requires a captured source';
  end if;
  -- The actual charge is the first lock: distinct PI aliases cannot race to
  -- mint two visible allocations. The PI index remains a collision backstop.
  perform pg_advisory_xact_lock(hashtextextended('platform-source-charge:'||p_charge,0));
  perform pg_advisory_xact_lock(hashtextextended('platform-hold-pi:'||p_payment_intent,0));
  select * into h from public.platform_payment_holds
    where source_payment_intent_id=p_payment_intent for update;
  if found then
    if h.owner_user_id is distinct from p_owner or h.owner_role is distinct from p_owner_role or
       h.stripe_charge_id is distinct from p_charge then
      raise exception 'captured payment already belongs to another recipient';
    end if;
  else
    select * into h from public.platform_payment_holds
      where source=p_source and source_id=p_source_id for update;
    if not found then
      -- Old Checkout holds may know the charge but not its PI. A PI callback
      -- must not create a second visible entitlement beside that legacy row.
      -- Without exact component provenance, adoption needs explicit review.
      if exists(select 1 from public.platform_payment_holds
        where stripe_charge_id=p_charge and source_verified_at is not null for update) then
        raise exception 'captured charge has another allocation requiring review';
      end if;
      if exists(select 1 from public.platform_payment_holds
        where stripe_charge_id=p_charge for update) then
        raise exception 'captured charge has an unverified legacy allocation';
      end if;
      insert into public.platform_payment_holds
        (owner_user_id,owner_role,source,source_id,amount_cents,status,
         stripe_charge_id,source_payment_intent_id,stripe_transfer_id)
        values(p_owner,p_owner_role,p_source,p_source_id,p_original_net,
          case when p_destination is null then 'classified_held' else 'transferred' end,
          p_charge,p_payment_intent,p_transfer) returning * into h;
      v_created:=true;
    elsif h.owner_user_id is distinct from p_owner or h.owner_role is distinct from p_owner_role or
          h.stripe_charge_id is distinct from p_charge or
          h.source_payment_intent_id is not null and
          h.source_payment_intent_id is distinct from p_payment_intent then
      raise exception 'platform hold source belongs to another payment';
    end if;
  end if;
  if exists(select 1 from public.platform_payment_holds
    where stripe_charge_id=p_charge and id<>h.id for update) then
    raise exception 'captured charge has another allocation requiring review';
  end if;
  perform public.verify_platform_hold_source(h.id,p_owner,p_charge,p_payment_intent,
    p_charge_gross,p_principal,p_original_net,p_fee_payer,
    p_destination,p_transfer,p_transfer_gross,p_application_fee_cents,
    p_application_fee_id,p_components);
  hold_id:=h.id;
  credited:=v_created;
  return next;
end $$;

-- New manager holds can project the same verified component entitlement into
-- the balance ledger. This is ONE transaction with canonical charge/PI credit:
-- an unknown reply cannot leave a visible hold without its mirror or mint the
-- mirror twice on replay. A missing Stripe availability date stays pending.
create or replace function public.credit_verified_platform_income_mirror(
  p_owner uuid,p_source text,p_source_id text,p_charge text,p_payment_intent text,
  p_charge_gross integer,p_principal integer,p_original_net integer,
  p_fee_payer text,p_components jsonb,p_available_on timestamptz default null
) returns table(hold_id uuid,credited boolean)
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_result record; h public.platform_payment_holds; v_account uuid;
  v_component jsonb; v_entry public.proplane_balance_entries;
  v_source text; v_net integer; v_expected integer:=0; v_existing integer;
begin
  if p_owner is null or jsonb_typeof(p_components) is distinct from 'array' then
    raise exception 'classified manager source is incomplete';
  end if;
  -- Future-owner-income debt recovery also starts with this lock. It cannot
  -- later be acquired under a charge/hold lock by this routine.
  perform pg_advisory_xact_lock(hashtextextended('platform-owner-recovery:'||p_owner::text,0));
  select * into v_result from public.credit_verified_platform_hold(
    p_owner,'manager',p_source,p_source_id,p_charge,p_payment_intent,
    p_charge_gross,p_principal,p_original_net,p_fee_payer,p_components);
  if v_result.hold_id is null then raise exception 'classified source credit is missing'; end if;
  select * into h from public.platform_payment_holds where id=v_result.hold_id for update;
  if h.owner_user_id is distinct from p_owner or h.source_allocation_mode<>'hold' or
     h.stripe_charge_id is distinct from p_charge or
     h.source_payment_intent_id is distinct from p_payment_intent then
    raise exception 'classified source mirror owner mismatch';
  end if;
  v_account:=public.proplane_balance_ensure_account('workspace',p_owner::text,'usd');
  perform 1 from public.proplane_balance_accounts where id=v_account for update;
  if exists(select 1 from public.proplane_balance_entries
    where kind='resident_payment' and stripe_object_id=p_charge and
      source_hold_id is null) then
    raise exception 'captured charge has an unclassified legacy balance credit';
  end if;
  select count(*)::integer into v_existing from public.proplane_balance_entries
    where source_hold_id=h.id and kind='resident_payment';
  for v_component in select value from jsonb_array_elements(p_components) as value loop
    v_source:=v_component->>'source_id';
    v_net:=(v_component->>'recipient_net_cents')::integer;
    if v_net=0 then continue; end if;
    v_expected:=v_expected+1;
    select * into v_entry from public.proplane_balance_entries
      where source_hold_id=h.id and source_component_id=v_source for update;
    if found then
      if v_result.credited or v_entry.account_id is distinct from v_account or
         v_entry.kind<>'resident_payment' or v_entry.amount_cents is distinct from v_net or
         v_entry.source_liability_class is distinct from v_component->>'liability_class' or
         v_entry.stripe_object_id is distinct from p_charge or
         v_entry.idempotency_key is distinct from 'source-mirror:'||h.id::text||':'||v_source or
         (v_entry.available_on is not null and p_available_on is not null and
          v_entry.available_on is distinct from p_available_on) or
         (v_entry.status='available' and v_entry.available_on is null) then
        raise exception 'classified balance mirror changed immutable source';
      end if;
      if v_entry.available_on is null and p_available_on is not null then
        update public.proplane_balance_entries set available_on=p_available_on where id=v_entry.id;
        -- A pending refund/release debit cancels this same component. Its
        -- clearing date must advance with the source credit so settling due
        -- cannot expose a refunded/released credit on its own.
        update public.proplane_balance_entries set available_on=p_available_on
          where account_id=v_account and amount_cents<0 and kind='adjustment' and
            status='pending' and available_on is null and
            source_spend_breakdown @> jsonb_build_array(jsonb_build_object(
              'hold_id',h.id,'source_id',v_source));
      end if;
    else
      if not v_result.credited or v_existing<>0 or
         h.status<>'classified_held' or h.amount_cents is distinct from h.original_amount_cents then
        raise exception 'existing source lacks an exact classified mirror';
      end if;
      insert into public.proplane_balance_entries
        (account_id,amount_cents,kind,status,available_on,stripe_object_id,
         idempotency_key,source_hold_id,source_component_id,source_liability_class)
        values(v_account,v_net,'resident_payment','pending',p_available_on,p_charge,
          'source-mirror:'||h.id::text||':'||v_source,h.id,v_source,
          v_component->>'liability_class');
    end if;
  end loop;
  if not v_result.credited and v_existing is distinct from v_expected then
    raise exception 'classified balance mirror is incomplete';
  end if;
  hold_id:=h.id; credited:=v_result.credited; return next;
end $$;

create or replace function public.reserve_platform_hold_transfer(
  p_hold uuid,p_owner uuid,p_attempt text,p_destination text,p_charge text
) returns public.platform_hold_transfer_attempts
language plpgsql security definer set search_path=public,pg_temp as $$
declare h public.platform_payment_holds; a public.platform_hold_transfer_attempts;
  v_saved_account text; v_charge text; v_component jsonb; v_captured_component jsonb;
  v_breakdown jsonb:='[]'::jsonb;
  v_source text; v_captured integer; v_refunded integer; v_consumed integer;
  v_transferred integer; v_reserved_debt integer;
  v_remaining integer; v_total integer:=0; v_releasable integer:=0; v_wallet_account uuid;
  v_mirror_count integer; v_expected_mirrors integer; v_mirror public.proplane_balance_entries;
begin
  if p_owner is null then raise exception 'platform hold owner is required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('platform-owner-recovery:'||p_owner::text,0));
  select stripe_charge_id into v_charge from public.platform_payment_holds where id=p_hold;
  if nullif(trim(v_charge),'') is null then raise exception 'platform hold source needs review'; end if;
  perform pg_advisory_xact_lock(hashtextextended('platform-source-charge:'||v_charge,0));
  select * into h from public.platform_payment_holds where id=p_hold for update;
  if not found or p_owner is null or h.owner_user_id is distinct from p_owner or
     h.stripe_charge_id is distinct from v_charge then
    raise exception 'platform hold owner mismatch';
  end if;
  select * into a from public.platform_hold_transfer_attempts
    where attempt_key=p_attempt for update;
  if found and a.hold_id is distinct from p_hold then
    raise exception 'platform transfer key belongs to another source';
  end if;
  if not found then
    select * into a from public.platform_hold_transfer_attempts
      where hold_id=p_hold and status='reserved' for update;
  end if;
  if not found and h.status in ('transferred','refunded') then
    select * into a from public.platform_hold_transfer_attempts
      where hold_id=p_hold and status='created'
      order by created_at desc,id desc limit 1 for update;
  end if;
  if found then
    if a.owner_user_id is distinct from p_owner or a.source_charge_id is distinct from h.stripe_charge_id or
       a.destination_account_id is null or a.amount_cents<=0 or
       (a.status='reserved' and (h.status<>'classified_held' or h.amount_cents<a.amount_cents)) or
       (a.status='created' and (a.stripe_transfer_id is null or
         h.stripe_transfer_id is null or h.status not in ('classified_held','transferred','refunded'))) then
      raise exception 'platform transfer retry changed source';
    end if;
    return a;
  end if;
  if h.status<>'classified_held' or
     h.source_verified_at is null or h.original_amount_cents is null or
     h.stripe_charge_id is distinct from p_charge or h.amount_cents<=0 then
    raise exception 'platform hold is not verified and releasable';
  end if;
  if public.platform_source_has_unmapped_refund(v_charge) then
    raise exception 'captured source has unresolved refund evidence';
  end if;
  if exists(select 1 from public.platform_hold_refund_attempts where hold_id=p_hold and status='reserved') then
    raise exception 'platform hold has unresolved refund';
  end if;
  if exists(select 1 from public.platform_hold_refund_attempts where hold_id=p_hold and
    status='succeeded' and recipient_debit_components is null) then
    raise exception 'historical source refund needs review';
  end if;
  if exists(select 1 from public.platform_source_consumption_legs
    where hold_id=p_hold and status='reserved' and kind<>'owner_debt_recovery') then
    raise exception 'platform source has unresolved consumption';
  end if;
  if jsonb_typeof(h.source_components) is distinct from 'array' or
     jsonb_array_length(h.source_components)=0 then
    raise exception 'platform source components need review';
  end if;
  for v_component in select value from jsonb_array_elements(h.source_components) as value loop
    v_source:=v_component->>'source_id';
    v_captured:=(v_component->>'recipient_net_cents')::integer;
    select coalesce(sum((debit.value->>'recipient_debit_cents')::integer),0)::integer
      into v_refunded from public.platform_hold_refund_attempts r,
      lateral jsonb_array_elements(r.recipient_debit_components) as debit(value)
      where r.hold_id=h.id and r.status='succeeded' and debit.value->>'source_id'=v_source;
    select coalesce(sum(leg.source_net_cents),0)::integer into v_consumed
      from public.platform_source_consumption_legs leg
      where leg.hold_id=h.id and leg.source_component_id=v_source and leg.status='settled';
    select coalesce(sum((breakdown.value->>'recipient_net_cents')::integer),0)::integer
      into v_transferred from public.platform_hold_transfer_attempts transfer_leg,
        lateral jsonb_array_elements(transfer_leg.component_breakdown) as breakdown(value)
      where transfer_leg.hold_id=h.id and transfer_leg.status='created' and
        breakdown.value->>'source_id'=v_source;
    v_transferred:=v_transferred-coalesce((select sum((part.value->>'recipient_net_cents')::integer)::integer
      from public.platform_hold_refund_transfer_legs reversed_leg,
        lateral jsonb_array_elements(reversed_leg.component_breakdown) as part(value)
      where reversed_leg.hold_id=h.id and reversed_leg.status='created' and
        part.value->>'source_id'=v_source),0);
    select coalesce(sum(leg.source_net_cents),0)::integer into v_reserved_debt
      from public.platform_source_consumption_legs leg
      where leg.hold_id=h.id and leg.source_component_id=v_source and
        leg.kind='owner_debt_recovery' and leg.status='reserved';
    v_remaining:=v_captured-v_refunded-v_consumed;
    if v_remaining<0 then raise exception 'platform component was overconsumed'; end if;
    v_total:=v_total+v_remaining;
    if v_transferred+v_reserved_debt>v_remaining then
      raise exception 'platform transfers and debt reservations exceed source'; end if;
    v_releasable:=v_releasable+v_remaining-v_transferred-v_reserved_debt;
    v_breakdown:=v_breakdown||jsonb_build_array(jsonb_build_object(
      'source_id',v_source,'recipient_net_cents',v_remaining-v_transferred-v_reserved_debt));
  end loop;
  if v_total is distinct from h.amount_cents then
    raise exception 'platform hold remainder differs from captured components';
  end if;
  if v_releasable<=0 then raise exception 'platform hold has no releasable residual'; end if;
  if nullif(trim(p_attempt),'') is null or nullif(trim(p_destination),'') is null then
    raise exception 'transfer destination and attempt are required';
  end if;
  -- A new attempt can only target the currently saved account. Lock its
  -- profile row after the source so a concurrent relink cannot win between
  -- the readiness read and this reservation. Existing attempts above retain
  -- their original destination even after an authorized relink.
  select stripe_connect_account_id into v_saved_account from public.profiles
    where id=p_owner for update;
  if not found or v_saved_account is distinct from p_destination then
    raise exception 'transfer destination changed before reservation';
  end if;
  insert into public.platform_hold_transfer_attempts
    (hold_id,attempt_key,owner_user_id,destination_account_id,source_charge_id,amount_cents,component_breakdown,status)
    values(p_hold,p_attempt,p_owner,p_destination,p_charge,v_releasable,v_breakdown,'reserved') returning * into a;
  select count(*)::integer into v_mirror_count from public.proplane_balance_entries
    where source_hold_id=h.id and kind='resident_payment';
  select count(*)::integer into v_expected_mirrors
    from jsonb_array_elements(h.source_components) as c(value)
    where (c.value->>'recipient_net_cents')::integer>0;
  if v_mirror_count>0 then
    if v_mirror_count is distinct from v_expected_mirrors or h.owner_role<>'manager' then
      raise exception 'classified release mirror needs source review';
    end if;
    select id into v_wallet_account from public.proplane_balance_accounts
      where owner_kind='workspace' and owner_key=p_owner::text and currency='usd' for update;
    if v_wallet_account is null then raise exception 'classified release wallet account missing'; end if;
    for v_component in select value from jsonb_array_elements(v_breakdown) as value loop
      v_source:=v_component->>'source_id';
      v_remaining:=(v_component->>'recipient_net_cents')::integer;
      if v_remaining=0 then continue; end if;
      select * into v_mirror from public.proplane_balance_entries
        where source_hold_id=h.id and source_component_id=v_source for update;
      select value into v_captured_component from jsonb_array_elements(h.source_components) as value
        where value->>'source_id'=v_source;
      if v_mirror.id is null or v_mirror.account_id is distinct from v_wallet_account or
         v_mirror.amount_cents is distinct from (v_captured_component->>'recipient_net_cents')::integer or
         v_mirror.source_liability_class is distinct from v_captured_component->>'liability_class' or
         v_mirror.stripe_object_id is distinct from h.stripe_charge_id then
        raise exception 'classified release mirror differs from source';
      end if;
      insert into public.proplane_balance_entries
        (account_id,amount_cents,kind,status,available_on,idempotency_key,
         source_spend_breakdown,source_income_debit_cents)
        values(v_wallet_account,-v_remaining,'adjustment',v_mirror.status,v_mirror.available_on,
          'source-release:'||a.id::text||':'||v_source,
          jsonb_build_array(jsonb_build_object('hold_id',h.id,'source_id',v_source,
            'source_net_cents',v_remaining)),
          case when v_captured_component->>'liability_class'='income' then v_remaining else 0 end);
    end loop;
  elsif exists(select 1 from public.proplane_balance_entries
    where kind='resident_payment' and stripe_object_id=h.stripe_charge_id and
      source_hold_id is null) then
    raise exception 'unclassified legacy balance credit needs release review';
  end if;
  return a;
end $$;

create or replace function public.finish_platform_hold_transfer(
  p_hold uuid,p_owner uuid,p_attempt text,p_transfer text
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare h public.platform_payment_holds; a public.platform_hold_transfer_attempts;
  v_charge text; v_mirror_count integer; v_component jsonb;
  v_debit public.proplane_balance_entries; v_amount integer; v_wallet_account uuid;
begin
  if p_owner is null then raise exception 'platform hold owner is required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('platform-owner-recovery:'||p_owner::text,0));
  select stripe_charge_id into v_charge from public.platform_payment_holds where id=p_hold;
  if nullif(trim(v_charge),'') is null then raise exception 'platform hold source needs review'; end if;
  perform pg_advisory_xact_lock(hashtextextended('platform-source-charge:'||v_charge,0));
  select * into h from public.platform_payment_holds where id=p_hold for update;
  if not found or p_owner is null or h.owner_user_id is distinct from p_owner or
     h.stripe_charge_id is distinct from v_charge then raise exception 'platform hold owner mismatch'; end if;
  select * into a from public.platform_hold_transfer_attempts
    where hold_id=p_hold and attempt_key=p_attempt for update;
  if not found or a.status='failed' or nullif(trim(p_transfer),'') is null or
     a.owner_user_id is distinct from p_owner or
     a.source_charge_id is distinct from v_charge or
     jsonb_typeof(a.component_breakdown) is distinct from 'array' or
     (select coalesce(sum((value->>'recipient_net_cents')::integer),0)::integer
       from jsonb_array_elements(a.component_breakdown) as value) is distinct from a.amount_cents then
    raise exception 'platform transfer attempt mismatch';
  end if;
  if a.status='created' then
    -- A later completed residual transfer does not overwrite the first
    -- transfer ID retained on the old hold/receipt row.
    if a.stripe_transfer_id is distinct from p_transfer or h.stripe_transfer_id is null then
      raise exception 'platform transfer replay mismatch';
    end if;
    return false;
  end if;
  if h.status<>'classified_held' or h.amount_cents<a.amount_cents or
     h.stripe_charge_id is distinct from a.source_charge_id then
    raise exception 'platform hold changed before transfer settlement';
  end if;
  if public.platform_source_has_unmapped_refund(v_charge) then
    raise exception 'captured source has unresolved refund evidence';
  end if;
  select count(*)::integer into v_mirror_count from public.proplane_balance_entries
    where source_hold_id=h.id and kind='resident_payment';
  if v_mirror_count>0 then
    select id into v_wallet_account from public.proplane_balance_accounts
      where owner_kind='workspace' and owner_key=p_owner::text and currency='usd' for update;
    if v_wallet_account is null then raise exception 'classified release wallet account missing'; end if;
    for v_component in select value from jsonb_array_elements(a.component_breakdown) as value loop
      v_amount:=(v_component->>'recipient_net_cents')::integer;
      if v_amount=0 then continue; end if;
      select * into v_debit from public.proplane_balance_entries
        where idempotency_key='source-release:'||a.id::text||':'||(v_component->>'source_id')
        for update;
      if not found or v_debit.account_id is distinct from v_wallet_account or
         v_debit.amount_cents is distinct from -v_amount or
         v_debit.kind<>'adjustment' or v_debit.source_spend_breakdown is distinct from
           jsonb_build_array(jsonb_build_object('hold_id',h.id,
             'source_id',v_component->>'source_id','source_net_cents',v_amount)) or
         v_debit.stripe_object_id is not null then
        raise exception 'classified release mirror reservation is missing';
      end if;
      update public.proplane_balance_entries set stripe_object_id=p_transfer where id=v_debit.id;
    end loop;
  elsif exists(select 1 from public.proplane_balance_entries
    where kind='resident_payment' and stripe_object_id=v_charge and source_hold_id is null) then
    raise exception 'unclassified legacy balance credit needs release review';
  end if;
  update public.platform_hold_transfer_attempts set status='created',stripe_transfer_id=p_transfer,updated_at=now() where id=a.id;
  update public.platform_payment_holds set
    status=case when coalesce((select sum(prior.amount_cents)::integer
      from public.platform_hold_transfer_attempts prior
      where prior.hold_id=p_hold and prior.status='created'),0)=amount_cents
      then 'transferred' else 'classified_held' end,
    stripe_transfer_id=coalesce(stripe_transfer_id,p_transfer),updated_at=now() where id=p_hold;
  return true;
end $$;

-- An ambiguous provider create is never released by a caller assertion.
-- Keep no bare fail RPC until an exact terminal transfer failure contract
-- exists. Re-applying this migration also removes an earlier scratch version.
drop function if exists public.fail_platform_hold_transfer(uuid,uuid,text);

-- Financial snapshots must never page-truncate held sources or count an
-- UNKNOWN provider transfer as both held and connected-account available.
-- A reserved transfer remains visible as release-pending until exact finish.
create or replace function public.read_platform_hold_owner_funds(p_owner uuid)
returns table(held_cents bigint,release_pending_cents bigint)
language sql stable security definer set search_path=public,pg_temp as $$
  select
    coalesce(sum(h.amount_cents-coalesce(created.amount_cents,0)-coalesce(t.amount_cents,0)),0)::bigint,
    coalesce(sum(t.amount_cents),0)::bigint
  from public.platform_payment_holds h
  left join public.platform_hold_transfer_attempts t on t.hold_id=h.id and t.status='reserved'
  left join lateral (select
    coalesce((select sum(amount_cents)::integer from public.platform_hold_transfer_attempts
      where hold_id=h.id and status='created'),0)-
    coalesce((select sum(amount_cents)::integer from public.platform_hold_refund_transfer_legs
      where hold_id=h.id and status='created'),0) as amount_cents) created on true
  where h.owner_user_id=p_owner and h.status in ('held','classified_held')
$$;

-- A classified manager balance move consumes actual captured income NET in
-- the same transaction as the established double-entry wallet move. It is a
-- new, uncalled RPC until the mirrored-credit and invoice claims use it.
create or replace function public.platform_balance_move_from_sources(
  p_owner uuid,p_payee_account uuid,p_amount bigint,p_root text,p_components jsonb
) returns table(payer_entry_id uuid,payee_entry_id uuid)
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_payer uuid; v_vendor uuid; v_row jsonb; v_hold public.platform_payment_holds;
  v_credit public.proplane_balance_entries; v_out public.proplane_balance_entries;
  v_in public.proplane_balance_entries; v_charge text; v_pi text;
  v_source text; v_requested integer; v_captured jsonb; v_captured_net integer;
  v_refunded integer; v_consumed integer; v_transferred integer;
  v_reversed integer; v_available bigint; v_total bigint:=0;
  v_held_total integer; v_expected_total integer; v_account uuid; v_source_snapshot jsonb;
begin
  if p_owner is null or p_payee_account is null or p_amount is null or p_amount<=0 or
     nullif(trim(p_root),'') is null or jsonb_typeof(p_components) is distinct from 'array' or
     jsonb_array_length(p_components)=0 then
    raise exception 'classified source move terms are incomplete';
  end if;
  -- Owner recovery may reserve eligible income in this same source, so it is
  -- always the first lock even when a pre-read found no outstanding debt.
  perform pg_advisory_xact_lock(hashtextextended('platform-owner-recovery:'||p_owner::text,0));
  -- Same-key replay can happen after all source net was spent or released.
  -- Validate its frozen entry pair before checking current source availability.
  select id into v_payer from public.proplane_balance_accounts
    where owner_kind='workspace' and owner_key=p_owner::text and currency='usd';
  select owner_key::uuid into v_vendor from public.proplane_balance_accounts
    where id=p_payee_account and owner_kind='vendor' and currency='usd';
  if v_payer is null or v_vendor is null or v_payer=p_payee_account then
    raise exception 'classified source wallet account mismatch';
  end if;
  if exists(select 1 from public.proplane_balance_entries
    where idempotency_key in (p_root||':out',p_root||':in')) then
    for v_account in select id from public.proplane_balance_accounts
        where id in (v_payer,p_payee_account) order by id for update loop
      perform 1;
    end loop;
    select * into v_out from public.proplane_balance_entries
      where idempotency_key=p_root||':out' for update;
    select * into v_in from public.proplane_balance_entries
      where idempotency_key=p_root||':in' for update;
    if v_out.id is null or v_in.id is null or
       v_out.account_id is distinct from v_payer or
       v_in.account_id is distinct from p_payee_account or
       v_out.amount_cents is distinct from -p_amount or
       v_in.amount_cents is distinct from p_amount or
       v_out.source_spend_breakdown is distinct from p_components or
       v_out.source_income_debit_cents is distinct from p_amount or
       v_out.kind is distinct from 'vendor_payment_out' or
       v_in.kind is distinct from 'vendor_payment_in' or
       v_out.status is distinct from 'available' or
       v_in.status is distinct from 'available' or
       v_out.related_entry_id is distinct from v_in.id or
       v_in.related_entry_id is distinct from v_out.id or
       (select count(*) from public.platform_source_consumption_legs
         where wallet_debit_entry_id=v_out.id and wallet_credit_entry_id=v_in.id
           and status='settled') is distinct from jsonb_array_length(p_components) or
       exists(select 1 from jsonb_array_elements(p_components) as c(value)
         where not exists(select 1 from public.platform_source_consumption_legs leg
           where leg.wallet_debit_entry_id=v_out.id and leg.wallet_credit_entry_id=v_in.id
             and leg.hold_id=(c.value->>'hold_id')::uuid and
             leg.source_component_id=c.value->>'source_id' and
             leg.source_net_cents=(c.value->>'source_net_cents')::integer and
             leg.owner_user_id=p_owner and leg.beneficiary_user_id=v_vendor and
             leg.kind='vendor_payment' and
             leg.beneficiary_principal_cents=(c.value->>'source_net_cents')::integer and
             leg.beneficiary_net_cents=(c.value->>'source_net_cents')::integer and
             leg.vendor_fee_cents=0 and
             leg.status='settled')) then
      raise exception 'classified source move replay changed immutable terms';
    end if;
    payer_entry_id:=v_out.id; payee_entry_id:=v_in.id; return next; return;
  end if;
  if exists(select 1 from jsonb_array_elements(p_components) as c(value)
    where jsonb_typeof(c.value) is distinct from 'object' or
      jsonb_typeof(c.value->'hold_id') is distinct from 'string' or
      jsonb_typeof(c.value->'source_id') is distinct from 'string' or
      nullif(trim(c.value->>'source_id'),'') is null or
      jsonb_typeof(c.value->'source_net_cents') is distinct from 'number' or
      (c.value->>'source_net_cents') !~ '^[1-9][0-9]*$') then
    raise exception 'classified source move component is invalid';
  end if;
  if (select count(*) from jsonb_array_elements(p_components)) is distinct from
     (select count(distinct (value->>'hold_id',value->>'source_id'))
      from jsonb_array_elements(p_components) as value) then
    raise exception 'classified source move repeats a component';
  end if;
  select jsonb_object_agg(h.id::text,jsonb_build_object('charge',h.stripe_charge_id,
    'payment_intent',h.source_payment_intent_id)) into v_source_snapshot
    from public.platform_payment_holds h where h.id in
      (select (value->>'hold_id')::uuid from jsonb_array_elements(p_components) as value);
  for v_charge in select distinct h.stripe_charge_id
      from jsonb_array_elements(p_components) as c(value)
      join public.platform_payment_holds h on h.id=(c.value->>'hold_id')::uuid
      order by h.stripe_charge_id loop
    if nullif(trim(v_charge),'') is null then raise exception 'classified source charge needs review'; end if;
    perform pg_advisory_xact_lock(hashtextextended('platform-source-charge:'||v_charge,0));
  end loop;
  for v_pi in select distinct h.source_payment_intent_id
      from jsonb_array_elements(p_components) as c(value)
      join public.platform_payment_holds h on h.id=(c.value->>'hold_id')::uuid
      order by h.source_payment_intent_id loop
    if nullif(trim(v_pi),'') is null then raise exception 'classified source PI needs review'; end if;
    perform pg_advisory_xact_lock(hashtextextended('platform-hold-pi:'||v_pi,0));
  end loop;
  for v_hold in select h.* from public.platform_payment_holds h
      where h.id in (select (value->>'hold_id')::uuid from jsonb_array_elements(p_components) as value)
      order by h.id for update loop
    if v_hold.owner_user_id is distinct from p_owner or v_hold.owner_role<>'manager' or
       v_hold.status<>'classified_held' or v_hold.source_verified_at is null or
       nullif(trim(v_hold.stripe_charge_id),'') is null or
       v_hold.stripe_charge_id is distinct from
         (v_source_snapshot->v_hold.id::text->>'charge') or
       v_hold.source_payment_intent_id is distinct from
         (v_source_snapshot->v_hold.id::text->>'payment_intent') or
       public.platform_source_has_unmapped_refund(v_hold.stripe_charge_id) or
       exists(select 1 from public.platform_hold_refund_attempts r
         where r.hold_id=v_hold.id and r.status='reserved') or
       exists(select 1 from public.platform_hold_transfer_attempts t
         where t.hold_id=v_hold.id and t.status='reserved') then
      raise exception 'classified source is not available for spend';
    end if;
    select coalesce(sum((value->>'source_net_cents')::integer),0)::integer
      into v_held_total from jsonb_array_elements(p_components) as value
      where (value->>'hold_id')::uuid=v_hold.id;
    if exists(select 1 from public.platform_hold_refund_attempts r
      where r.hold_id=v_hold.id and r.status='succeeded' and
        r.recipient_debit_components is null) then
      raise exception 'historical source refund needs review';
    end if;
    select
      (select coalesce(sum((c.value->>'recipient_net_cents')::integer),0)::integer
       from jsonb_array_elements(v_hold.source_components) as c(value)) -
      (select coalesce(sum((d.value->>'recipient_debit_cents')::integer),0)::integer
       from public.platform_hold_refund_attempts r,
       lateral jsonb_array_elements(r.recipient_debit_components) as d(value)
       where r.hold_id=v_hold.id and r.status='succeeded') -
      (select coalesce(sum(source_net_cents),0)::integer
       from public.platform_source_consumption_legs
       where hold_id=v_hold.id and status='settled') into v_expected_total;
    if v_expected_total is distinct from v_hold.amount_cents then
      raise exception 'classified source remainder differs from captured components';
    end if;
    if v_held_total>v_hold.amount_cents then
      raise exception 'classified spend exceeds held remainder';
    end if;
  end loop;
  if (select count(distinct (value->>'hold_id')::uuid)
      from jsonb_array_elements(p_components) as value) is distinct from
     (select count(*) from public.platform_payment_holds h
      where h.id in (select (value->>'hold_id')::uuid from jsonb_array_elements(p_components) as value)) then
    raise exception 'classified source hold is missing';
  end if;
  for v_row in select value from jsonb_array_elements(p_components) as value loop
    select * into v_hold from public.platform_payment_holds where id=(v_row->>'hold_id')::uuid;
    v_source:=v_row->>'source_id'; v_requested:=(v_row->>'source_net_cents')::integer;
    select value into v_captured from jsonb_array_elements(v_hold.source_components) as value
      where value->>'source_id'=v_source;
    if not found or v_captured->>'liability_class' is distinct from 'income' then
      raise exception 'classified balance spending requires captured income';
    end if;
    v_captured_net:=(v_captured->>'recipient_net_cents')::integer;
    select coalesce(sum((d.value->>'recipient_debit_cents')::integer),0)::integer
      into v_refunded from public.platform_hold_refund_attempts r,
      lateral jsonb_array_elements(r.recipient_debit_components) as d(value)
      where r.hold_id=v_hold.id and r.status='succeeded' and d.value->>'source_id'=v_source;
    select coalesce(sum(source_net_cents),0)::integer into v_consumed
      from public.platform_source_consumption_legs
      where hold_id=v_hold.id and source_component_id=v_source and status='settled';
    select coalesce(sum((part.value->>'recipient_net_cents')::integer),0)::integer
      into v_transferred from public.platform_hold_transfer_attempts t,
        lateral jsonb_array_elements(t.component_breakdown) as part(value)
      where t.hold_id=v_hold.id and t.status='created' and
        part.value->>'source_id'=v_source;
    select coalesce(sum((part.value->>'recipient_net_cents')::integer),0)::integer
      into v_reversed from public.platform_hold_refund_transfer_legs l,
        lateral jsonb_array_elements(l.component_breakdown) as part(value)
      where l.hold_id=v_hold.id and l.status='created' and
        part.value->>'source_id'=v_source;
    if exists(select 1 from public.platform_hold_refund_attempts r
       where r.hold_id=v_hold.id and r.status='succeeded' and
         r.recipient_debit_components is null) or
       exists(select 1 from public.platform_source_consumption_legs
      where hold_id=v_hold.id and source_component_id=v_source and status='reserved') or
       v_transferred<v_reversed or
       v_captured_net-v_refunded-v_consumed-v_transferred+v_reversed<v_requested then
      raise exception 'classified component net is already consumed or reserved';
    end if;
    v_total:=v_total+v_requested;
  end loop;
  if v_total is distinct from p_amount then raise exception 'classified source move amount differs from components'; end if;
  for v_account in select id from public.proplane_balance_accounts
      where id in (v_payer,p_payee_account) order by id for update loop
    perform 1;
  end loop;
  if exists(select 1 from public.proplane_balance_entries
    where idempotency_key in (p_root||':out',p_root||':in')) then
    raise exception 'classified source move key is already used';
  end if;
  for v_row in select value from jsonb_array_elements(p_components) as value loop
    select value into v_captured from public.platform_payment_holds h,
      lateral jsonb_array_elements(h.source_components) as value
      where h.id=(v_row->>'hold_id')::uuid and value->>'source_id'=v_row->>'source_id';
    select * into v_credit from public.proplane_balance_entries
      where source_hold_id=(v_row->>'hold_id')::uuid and
        source_component_id=v_row->>'source_id' for update;
    if not found or v_credit.account_id is distinct from v_payer or
       v_credit.kind<>'resident_payment' or v_credit.status<>'available' or
       v_credit.available_on is null or v_credit.available_on>now() or
       v_credit.source_liability_class<>'income' or
       v_credit.amount_cents is distinct from (v_captured->>'recipient_net_cents')::integer or
       v_credit.stripe_object_id is distinct from
         (select stripe_charge_id from public.platform_payment_holds
          where id=(v_row->>'hold_id')::uuid) then
      raise exception 'classified income mirror is not cleared';
    end if;
  end loop;
  -- A deposit or unidentified legacy credit never funds a vendor. A debit
  -- without classified source legs reduces eligibility conservatively; a
  -- source-bound deposit withdrawal consumes no income eligibility.
  select coalesce(sum(case
      when amount_cents>0 and kind='resident_payment' and source_liability_class='income'
        then amount_cents
      when amount_cents<0 then -coalesce(source_income_debit_cents,-amount_cents)
      else 0 end),0) into v_available from public.proplane_balance_entries
    where account_id=v_payer and status='available';
  if v_available<p_amount then raise exception 'INSUFFICIENT_BALANCE: available=% requested=%',v_available,p_amount; end if;
  insert into public.proplane_balance_entries
    (account_id,amount_cents,kind,status,available_on,idempotency_key,source_spend_breakdown,source_income_debit_cents)
    values(v_payer,-p_amount,'vendor_payment_out','available',now(),p_root||':out',p_components,p_amount)
    returning * into v_out;
  insert into public.proplane_balance_entries
    (account_id,amount_cents,kind,status,available_on,idempotency_key,related_entry_id)
    values(p_payee_account,p_amount,'vendor_payment_in','available',now(),p_root||':in',v_out.id)
    returning * into v_in;
  update public.proplane_balance_entries set related_entry_id=v_in.id where id=v_out.id;
  for v_row in select value from jsonb_array_elements(p_components) as value loop
    insert into public.platform_source_consumption_legs
      (hold_id,source_component_id,owner_user_id,kind,source_net_cents,
       beneficiary_user_id,beneficiary_principal_cents,beneficiary_net_cents,vendor_fee_cents,
       wallet_debit_entry_id,wallet_credit_entry_id,attempt_key,status)
      values((v_row->>'hold_id')::uuid,v_row->>'source_id',p_owner,'vendor_payment',
        (v_row->>'source_net_cents')::integer,v_vendor,(v_row->>'source_net_cents')::integer,
        (v_row->>'source_net_cents')::integer,0,
        v_out.id,v_in.id,p_root||':source:'||(v_row->>'hold_id')||':'||(v_row->>'source_id'),'settled');
  end loop;
  for v_hold in select h.* from public.platform_payment_holds h
      where h.id in (select (value->>'hold_id')::uuid from jsonb_array_elements(p_components) as value)
      order by h.id loop
    select coalesce(sum((value->>'source_net_cents')::integer),0)::integer
      into v_held_total from jsonb_array_elements(p_components) as value
      where (value->>'hold_id')::uuid=v_hold.id;
    update public.platform_payment_holds set amount_cents=amount_cents-v_held_total,updated_at=now()
      where id=v_hold.id;
  end loop;
  payer_entry_id:=v_out.id; payee_entry_id:=v_in.id; return next;
end $$;

drop function if exists public.reserve_platform_money_refund(uuid,text,integer,uuid,uuid);
drop function if exists public.reserve_platform_money_refund(uuid,text,integer,uuid,uuid,integer,text,boolean,boolean);
create or replace function public.reserve_platform_money_refund(
  p_owner uuid,p_attempt text,p_gross integer,p_hold uuid default null,p_payout uuid default null,
  p_principal integer default null,p_reason text default 'requested_by_customer',
  p_reverse_transfer boolean default false,p_refund_application_fee boolean default false,
  p_components jsonb default null
) returns public.platform_hold_refund_attempts
language plpgsql security definer set search_path=public,pg_temp as $$
declare h public.platform_payment_holds; p public.vendor_payouts; a public.platform_hold_refund_attempts;
  prior_principal integer:=0; previous_target integer; next_target integer;
  v_principal integer:=coalesce(p_principal,p_gross); v_fee integer:=0; v_debit integer:=0;
  v_debt integer:=0; v_charge text; v_precharge text;
  v_components jsonb; v_debit_components jsonb:='[]'::jsonb;
  v_held_components jsonb:='[]'::jsonb; v_reversal_plan jsonb:='{}'::jsonb;
  v_plan_entry jsonb; v_plan_key text; v_held_debit integer:=0;
  v_transfer_debit integer:=0; v_held_available integer;
  v_transfer_outstanding integer; v_need_transfer integer; v_leg_available integer;
  v_prior_leg_reversed integer; v_leg_captured integer; v_leg_take integer;
  v_transfer_leg public.platform_hold_transfer_attempts; v_plan_row record;
  requested jsonb; captured jsonb; v_source text;
  requested_cents integer; captured_principal integer; captured_net integer;
  prior_component integer; prior_component_debit integer; consumed_component integer;
  component_remaining integer; component_debit integer; requested_sum integer:=0;
begin
  if p_hold is null and p_payout is null then raise exception 'refund source required'; end if;
  if p_owner is null or nullif(trim(p_attempt),'') is null or
     p_gross is null or v_principal is null or
     p_reverse_transfer is null or p_refund_application_fee is null or
     p_gross<=0 or v_principal<=0 or
     v_principal>p_gross or p_reason is null or
     p_reason not in ('requested_by_customer','duplicate','fraudulent') then
    raise exception 'invalid refund attempt';
  end if;
  if p_hold is not null then
    select stripe_charge_id,owner_role into v_precharge,v_source
      from public.platform_payment_holds where id=p_hold;
    if v_source='manager' then
      perform pg_advisory_xact_lock(hashtextextended('platform-owner-recovery:'||p_owner::text,0));
    end if;
  else
    select stripe_charge_id into v_precharge from public.vendor_payouts where id=p_payout;
  end if;
  if nullif(trim(v_precharge),'') is null then raise exception 'refund source charge needs review'; end if;
  perform pg_advisory_xact_lock(hashtextextended('platform-source-charge:'||v_precharge,0));
  if p_hold is not null then
    select * into h from public.platform_payment_holds where id=p_hold for update;
    if not found or h.owner_user_id is distinct from p_owner or h.source_verified_at is null or
       h.original_amount_cents is null or h.source_charge_gross_cents is null or
       h.stripe_charge_id is distinct from v_precharge then
      raise exception 'platform refund source needs review'; end if;
  end if;
  if p_payout is not null then
    select * into p from public.vendor_payouts where id=p_payout for update;
    if not found or p.vendor_user_id is distinct from p_owner or
       p.stripe_charge_id is distinct from v_precharge then
      raise exception 'vendor payout owner mismatch';
    end if;
    if p_hold is not null and (h.owner_role<>'vendor' or h.source<>'vendor_invoice' or
       p.platform_hold_id is distinct from h.id or
       p.stripe_charge_id is distinct from h.stripe_charge_id or
       h.source_principal_cents is distinct from p.amount_cents or
       h.original_amount_cents is distinct from p.amount_cents-p.platform_fee_cents or
       h.source_components is null or jsonb_array_length(h.source_components)<>1 or
       (h.source_components->0->>'liability_class') is distinct from 'vendor') then
      raise exception 'vendor payout does not match hold';
    end if;
  end if;
  if p_hold is not null and h.owner_role='vendor' and p_payout is null then
    raise exception 'vendor refund requires exact payout';
  end if;
  if p_hold is not null and exists(select 1 from public.platform_hold_refund_attempts
    where hold_id=p_hold and status='succeeded' and
      (refund_components is null or
       (h.owner_role='manager' and recipient_debit_components is null))) then
    raise exception 'historical refund components need source review';
  end if;
  if p_hold is not null and exists(select 1 from public.platform_source_consumption_legs
    where hold_id=p_hold and status='reserved' and kind<>'owner_debt_recovery') then
    raise exception 'platform source has unresolved consumption';
  end if;
  if p_components is null then
    if p_hold is not null then
      if h.source_components is null or jsonb_array_length(h.source_components)<>1 then
        raise exception 'aggregate refund requires exact source components';
      end if;
      v_source:=h.source_components->0->>'source_id';
    else
      v_source:=coalesce(p.invoice_id::text,p.work_order_id::text,p.id::text);
    end if;
    v_components:=jsonb_build_array(jsonb_build_object('source_id',v_source,
      'principal_cents',v_principal));
  else
    v_components:=p_components;
  end if;
  if jsonb_typeof(v_components) is distinct from 'array' or
     jsonb_array_length(v_components)=0 then
    raise exception 'refund components must identify captured principal';
  end if;
  -- A paid/refunded same-key replay keeps its frozen allocation even after
  -- the component cap is exhausted. Reject changed terms before returning.
  select * into a from public.platform_hold_refund_attempts where attempt_key=p_attempt for update;
  if found then
    if a.owner_user_id is distinct from p_owner or a.hold_id is distinct from p_hold or
       a.payout_id is distinct from p_payout or a.gross_cents is distinct from p_gross or
       a.principal_cents is distinct from v_principal or
       a.refund_components is distinct from v_components or
       a.reverse_transfer is distinct from p_reverse_transfer or
       a.refund_application_fee is distinct from p_refund_application_fee or
       a.provider_reason is distinct from p_reason then
      raise exception 'refund retry changed immutable terms';
    end if;
    return a;
  end if;
  -- A prior payer refund has already reserved an exact recipient reversal.
  -- Until every provider leg is terminal, no second refund may reserve the
  -- same transfer even when this source still has some held cash.
  if p_hold is not null and exists(select 1 from public.platform_hold_refund_attempts
    where hold_id=p_hold and status='succeeded' and
      reversal_status in ('pending','shortfall')) then
    raise exception 'platform recipient transfer reversal needs review';
  end if;
  for requested in select value from jsonb_array_elements(v_components) as value loop
    if jsonb_typeof(requested) is distinct from 'object' or
       jsonb_typeof(requested->'source_id') is distinct from 'string' or
       nullif(trim(requested->>'source_id'),'') is null or
       jsonb_typeof(requested->'principal_cents') is distinct from 'number' or
       (requested->>'principal_cents') !~ '^[0-9]+$' then
      raise exception 'refund component source or principal invalid';
    end if;
    v_source:=requested->>'source_id';
    requested_cents:=(requested->>'principal_cents')::integer;
    if requested_cents<=0 or exists(select 1 from jsonb_array_elements(v_components) as other
       where other->>'source_id'=v_source and other<>requested) then
      raise exception 'refund component source or principal invalid';
    end if;
    requested_sum:=requested_sum+requested_cents;
    if p_hold is not null then
      select value into captured from jsonb_array_elements(h.source_components) as value
        where value->>'source_id'=v_source;
      if not found then raise exception 'refund component is not in captured source'; end if;
      captured_principal:=(captured->>'principal_cents')::integer;
      captured_net:=(captured->>'recipient_net_cents')::integer;
      select coalesce(sum((prior_component_row.value->>'principal_cents')::integer),0)::integer
        into prior_component
        from public.platform_hold_refund_attempts prior_attempt,
          lateral jsonb_array_elements(prior_attempt.refund_components) as prior_component_row(value)
        where prior_attempt.hold_id=p_hold and prior_attempt.status='succeeded' and
          prior_component_row.value->>'source_id'=v_source;
      if prior_component+requested_cents>captured_principal then
        raise exception 'refund exceeds captured component principal';
      end if;
      if h.owner_role='manager' then
        select coalesce(sum((debit.value->>'recipient_debit_cents')::integer),0)::integer
          into prior_component_debit
          from public.platform_hold_refund_attempts prior_attempt,
            lateral jsonb_array_elements(prior_attempt.recipient_debit_components) as debit(value)
          where prior_attempt.hold_id=p_hold and prior_attempt.status='succeeded' and
            debit.value->>'source_id'=v_source;
        select coalesce(sum(leg.source_net_cents),0)::integer into consumed_component
          from public.platform_source_consumption_legs leg
          where leg.hold_id=p_hold and leg.source_component_id=v_source and leg.status='settled';
        component_remaining:=captured_net-prior_component_debit-consumed_component;
        if component_remaining<0 then
          raise exception 'captured component net was overconsumed';
        end if;
        component_debit:=least(requested_cents,component_remaining);
        v_debit:=v_debit+component_debit;
        v_debt:=v_debt+requested_cents-component_debit;
        if h.source_allocation_mode='hold' then
          select coalesce(sum((part.value->>'recipient_net_cents')::integer),0)::integer
            into v_transfer_outstanding
            from public.platform_hold_transfer_attempts transfer_leg,
              lateral jsonb_array_elements(transfer_leg.component_breakdown) as part(value)
            where transfer_leg.hold_id=h.id and transfer_leg.status='created' and
              part.value->>'source_id'=v_source;
          select coalesce(sum((part.value->>'recipient_net_cents')::integer),0)::integer
            into v_prior_leg_reversed
            from public.platform_hold_refund_transfer_legs reversal_leg,
              lateral jsonb_array_elements(reversal_leg.component_breakdown) as part(value)
            where reversal_leg.hold_id=h.id and reversal_leg.status='created' and
              part.value->>'source_id'=v_source;
          v_transfer_outstanding:=v_transfer_outstanding-v_prior_leg_reversed;
          v_held_available:=component_remaining-v_transfer_outstanding;
          if v_transfer_outstanding<0 or v_held_available<0 then
            raise exception 'recipient transfer vector exceeds captured source';
          end if;
          v_leg_take:=least(component_debit,v_held_available);
          v_held_debit:=v_held_debit+v_leg_take;
          v_held_components:=v_held_components||jsonb_build_array(jsonb_build_object(
            'source_id',v_source,'recipient_net_cents',v_leg_take));
          v_need_transfer:=component_debit-v_leg_take;
          for v_transfer_leg in select * from public.platform_hold_transfer_attempts
            where hold_id=h.id and status='created' order by created_at,id loop
            exit when v_need_transfer=0;
            select coalesce((part.value->>'recipient_net_cents')::integer,0)
              into v_leg_captured from jsonb_array_elements(v_transfer_leg.component_breakdown) as part(value)
              where part.value->>'source_id'=v_source;
            v_leg_captured:=coalesce(v_leg_captured,0);
            select coalesce(sum((part.value->>'recipient_net_cents')::integer),0)::integer
              into v_prior_leg_reversed
              from public.platform_hold_refund_transfer_legs reversal_leg,
                lateral jsonb_array_elements(reversal_leg.component_breakdown) as part(value)
              where reversal_leg.transfer_attempt_id=v_transfer_leg.id and
                reversal_leg.status='created' and part.value->>'source_id'=v_source;
            v_leg_available:=v_leg_captured-v_prior_leg_reversed;
            if v_leg_available<0 then raise exception 'recipient reversal vector exceeds transfer'; end if;
            v_leg_take:=least(v_need_transfer,v_leg_available);
            if v_leg_take=0 then continue; end if;
            v_need_transfer:=v_need_transfer-v_leg_take;
            v_transfer_debit:=v_transfer_debit+v_leg_take;
            v_plan_key:=v_transfer_leg.id::text;
            v_plan_entry:=coalesce(v_reversal_plan->v_plan_key,jsonb_build_object(
              'transfer_id',v_transfer_leg.stripe_transfer_id,'amount_cents',0,
              'components','[]'::jsonb));
            v_plan_entry:=jsonb_set(v_plan_entry,'{amount_cents}',
              to_jsonb((v_plan_entry->>'amount_cents')::integer+v_leg_take));
            v_plan_entry:=jsonb_set(v_plan_entry,'{components}',
              (v_plan_entry->'components')||jsonb_build_array(jsonb_build_object(
                'source_id',v_source,'recipient_net_cents',v_leg_take)));
            v_reversal_plan:=jsonb_set(v_reversal_plan,array[v_plan_key],v_plan_entry,true);
          end loop;
          if v_need_transfer<>0 then raise exception 'recipient reversal vector is incomplete'; end if;
        end if;
        v_debit_components:=v_debit_components||jsonb_build_array(jsonb_build_object(
          'source_id',v_source,'principal_cents',requested_cents,
          'recipient_debit_cents',component_debit,
          'manager_debt_cents',requested_cents-component_debit));
      end if;
    elsif v_source is distinct from coalesce(p.invoice_id::text,p.work_order_id::text,p.id::text) or
          requested_cents>p.amount_cents then
      raise exception 'vendor refund component differs from payout source';
    end if;
  end loop;
  if requested_sum is distinct from v_principal or
     (select count(*) from jsonb_array_elements(v_components)) is distinct from
       (select count(distinct value->>'source_id') from jsonb_array_elements(v_components) as value) then
    raise exception 'refund components do not sum to principal';
  end if;
  if public.platform_source_has_unmapped_refund(v_precharge) then
    raise exception 'captured source has unresolved refund evidence';
  end if;
  if p_hold is not null and h.status not in ('classified_held','transferred','refunded') then
    raise exception 'platform hold refund needs source review';
  end if;
  if p_hold is not null and h.source_allocation_mode='hold' and
     v_held_debit+v_transfer_debit is distinct from v_debit then
    raise exception 'recipient refund vector does not conserve net';
  end if;
  if p_payout is not null and p.status not in ('paid','partially_refunded') then
    raise exception 'vendor payout not refundable';
  end if;
  if p_hold is not null and exists(select 1 from public.platform_hold_transfer_attempts
     where hold_id=p_hold and status='reserved') then
    raise exception 'platform hold has unresolved transfer';
  end if;
  if p_hold is not null and h.status='transferred' and
     (h.stripe_transfer_id is null or
      (h.source_allocation_mode='destination' and h.source_destination_account_id is null) or
      (h.source_allocation_mode='hold' and not exists(
        select 1 from public.platform_hold_transfer_attempts t where t.hold_id=h.id
          and t.status='created' and t.stripe_transfer_id=h.stripe_transfer_id)) or
      (h.source_allocation_mode='hold' and
        coalesce((select sum(t.amount_cents)::integer from public.platform_hold_transfer_attempts t
          where t.hold_id=h.id and t.status='created'),0)-
        coalesce((select sum(r.amount_cents)::integer from public.platform_hold_refund_transfer_legs r
          where r.hold_id=h.id and r.status='created'),0) is distinct from h.amount_cents) or
      exists(select 1 from public.platform_hold_refund_attempts
        where hold_id=p_hold and status='succeeded' and
          reversal_status in ('pending','shortfall'))) then
    raise exception 'platform recipient transfer reversal needs review';
  end if;
  if p_payout is not null then
    if p.platform_fee_cents<0 or p.platform_fee_cents>p.amount_cents then
      raise exception 'vendor payout fee needs review';
    end if;
    if v_principal<>p_gross then raise exception 'vendor provider refund differs from principal'; end if;
    prior_principal:=p.refunded_gross_cents;
    if prior_principal+v_principal>p.amount_cents then raise exception 'vendor refund exceeds remaining principal'; end if;
    previous_target:=round(prior_principal::numeric*p.platform_fee_cents/p.amount_cents);
    next_target:=round((prior_principal+v_principal)::numeric*p.platform_fee_cents/p.amount_cents);
    v_fee:=next_target-previous_target;
    v_debit:=v_principal-v_fee;
    v_charge:=p.stripe_charge_id;
    -- The vendor's three-percent share is separate from manager-paid
    -- processing. Freeze recipient NET against this exact captured payout,
    -- then split it across held cash and the vendor's completed transfers.
    if p_hold is not null and h.source_allocation_mode='hold' then
      v_source:=h.source_components->0->>'source_id';
      select coalesce(sum(t.amount_cents),0)::integer-
        coalesce((select sum(r.amount_cents)::integer
          from public.platform_hold_refund_transfer_legs r
          where r.hold_id=h.id and r.status='created'),0)
        into v_transfer_outstanding from public.platform_hold_transfer_attempts t
        where t.hold_id=h.id and t.status='created';
      v_held_available:=h.amount_cents-v_transfer_outstanding;
      if v_transfer_outstanding<0 or v_held_available<0 then
        raise exception 'vendor recipient transfer vector exceeds source'; end if;
      v_held_debit:=least(v_debit,v_held_available);
      v_held_components:=jsonb_build_array(jsonb_build_object(
        'source_id',v_source,'recipient_net_cents',v_held_debit));
      v_need_transfer:=v_debit-v_held_debit;
      for v_transfer_leg in select * from public.platform_hold_transfer_attempts
        where hold_id=h.id and status='created' order by created_at,id loop
        exit when v_need_transfer=0;
        select coalesce(sum(r.amount_cents),0)::integer into v_prior_leg_reversed
          from public.platform_hold_refund_transfer_legs r
          where r.transfer_attempt_id=v_transfer_leg.id and r.status='created';
        v_leg_available:=v_transfer_leg.amount_cents-v_prior_leg_reversed;
        if v_leg_available<0 then raise exception 'vendor reversal vector exceeds transfer'; end if;
        v_leg_take:=least(v_need_transfer,v_leg_available);
        if v_leg_take=0 then continue; end if;
        v_need_transfer:=v_need_transfer-v_leg_take;
        v_transfer_debit:=v_transfer_debit+v_leg_take;
        v_reversal_plan:=jsonb_set(v_reversal_plan,array[v_transfer_leg.id::text],
          jsonb_build_object('transfer_id',v_transfer_leg.stripe_transfer_id,
            'amount_cents',v_leg_take,'components',jsonb_build_array(jsonb_build_object(
              'source_id',v_source,'recipient_net_cents',v_leg_take))),true);
      end loop;
      if v_need_transfer<>0 or v_held_debit+v_transfer_debit is distinct from v_debit then
        raise exception 'vendor recipient reversal vector is incomplete'; end if;
    end if;
  elsif p_hold is not null then
    select coalesce(sum(principal_cents),0)::integer into prior_principal
      from public.platform_hold_refund_attempts where hold_id=p_hold and status='succeeded';
    if h.owner_role<>'manager' or h.source_principal_cents is null or h.source_fee_payer is null or
       prior_principal+v_principal>h.source_principal_cents then
      raise exception 'manager principal refund needs source review';
    end if;
    -- Internal manager refunds return principal first, not a fraction of the
    -- payer's gross processing fee. The beneficiary contributes at most its
    -- captured net; the remainder is a real owner-specific recovery debt.
    -- v_debit and v_debt are apportioned to each captured component. A
    -- manager-paid deposit fee creates its own real payable on refund; only
    -- later eligible income from the same owner may recover that payable.
    v_charge:=h.stripe_charge_id;
  end if;
  if v_charge is null then raise exception 'refund source charge needs review'; end if;
  if p_hold is not null and h.status='refunded' and
     (h.amount_cents<>0 or v_debit<>0) then
    raise exception 'refunded allocation cannot fund another recipient debit';
  end if;
  if p_gross<>v_principal or p_reverse_transfer or p_refund_application_fee then
    raise exception 'provider refund legs need source review';
  end if;
  if p_hold is not null and v_debit>h.amount_cents then raise exception 'refund exceeds held source'; end if;
  insert into public.platform_hold_refund_attempts
    (hold_id,payout_id,attempt_key,owner_user_id,gross_cents,principal_cents,refund_components,
     recipient_debit_components,source_charge_id,
     provider_reason,reverse_transfer,refund_application_fee,fee_share_cents,hold_debit_cents,
     held_cash_debit_cents,held_cash_debit_components,transfer_reversal_cents,
     manager_debt_cents,status)
    values(p_hold,p_payout,p_attempt,p_owner,p_gross,v_principal,v_components,
      case when p_hold is not null and h.owner_role='manager' then v_debit_components else null end,
      v_charge,p_reason,
      p_reverse_transfer,p_refund_application_fee,v_fee,v_debit,
      v_held_debit,case when p_hold is not null and h.source_allocation_mode='hold'
        then v_held_components else null end,v_transfer_debit,v_debt,'reserved') returning * into a;
  for v_plan_row in select key,value from jsonb_each(v_reversal_plan) loop
    insert into public.platform_hold_refund_transfer_legs
      (refund_attempt_id,transfer_attempt_id,hold_id,owner_user_id,
       source_charge_id,source_transfer_id,amount_cents,component_breakdown,status)
      values(a.id,v_plan_row.key::uuid,h.id,p_owner,v_charge,
        v_plan_row.value->>'transfer_id',(v_plan_row.value->>'amount_cents')::integer,
        v_plan_row.value->'components','reserved');
  end loop;
  return a;
end $$;

create or replace function public.finish_platform_money_refund(
  p_attempt text,p_refund text,p_gross integer
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.platform_hold_refund_attempts; h public.platform_payment_holds; p public.vendor_payouts;
  v_attempt_id uuid; v_charge text; v_wallet_account uuid;
  v_mirror public.proplane_balance_entries; v_component jsonb; v_captured jsonb;
  v_source text; v_net integer; v_mirror_count integer; v_expected_mirrors integer;
  v_source_cash_debit integer;
  v_reserved_leg public.platform_source_consumption_legs;
  v_prior_refund integer; v_consumed integer; v_outstanding_transfer integer;
  v_refund_cash integer; v_physical_after integer; v_allocated integer; v_successor integer;
begin
  select * into a from public.platform_hold_refund_attempts where attempt_key=p_attempt;
  if not found then raise exception 'refund attempt missing'; end if;
  v_attempt_id:=a.id; v_charge:=a.source_charge_id;
  if a.manager_debt_cents>0 or exists(select 1 from public.platform_payment_holds
      where id=a.hold_id and owner_role='manager') then
    perform pg_advisory_xact_lock(hashtextextended('platform-owner-recovery:'||a.owner_user_id::text,0));
  end if;
  perform pg_advisory_xact_lock(hashtextextended('platform-source-charge:'||v_charge,0));
  if a.hold_id is not null then select * into h from public.platform_payment_holds where id=a.hold_id for update; end if;
  if a.payout_id is not null then select * into p from public.vendor_payouts where id=a.payout_id for update; end if;
  select * into a from public.platform_hold_refund_attempts where attempt_key=p_attempt for update;
  if a.id is distinct from v_attempt_id or a.source_charge_id is distinct from v_charge or
     (a.hold_id is not null and h.stripe_charge_id is distinct from v_charge) or
     (a.payout_id is not null and p.stripe_charge_id is distinct from v_charge) or
     a.gross_cents is distinct from p_gross or nullif(trim(p_refund),'') is null or a.status='failed' or
     (a.stripe_refund_id is not null and a.stripe_refund_id is distinct from p_refund) then
    raise exception 'refund provider terms mismatch';
  end if;
  if a.status='succeeded' then
    if a.stripe_refund_id is distinct from p_refund then raise exception 'refund replay mismatch'; end if;
    return false;
  end if;
  if a.hold_id is not null and h.owner_role='manager' then
    -- Provider SUCCESS, not a tentative reservation, is the point at which
    -- an incoming-source debt offset can change. Reconcile every exact
    -- affected component while holding the owner and source locks. A partial
    -- refund keeps the still-backed portion reserved via an immutable child
    -- leg; the original attempt never changes its amount or provenance.
    for v_component in select value from jsonb_array_elements(a.refund_components) as value loop
      v_source:=v_component->>'source_id';
      select value into v_captured from jsonb_array_elements(h.source_components) as value
        where value->>'source_id'=v_source;
      if not found then raise exception 'refunded recovery component lost source'; end if;
      select coalesce(sum((part.value->>'recipient_debit_cents')::integer),0)::integer
        into v_prior_refund from public.platform_hold_refund_attempts r,
          lateral jsonb_array_elements(r.recipient_debit_components) as part(value)
        where r.hold_id=h.id and r.status='succeeded' and
          part.value->>'source_id'=v_source;
      select coalesce(sum(source_net_cents),0)::integer into v_consumed
        from public.platform_source_consumption_legs
        where hold_id=h.id and source_component_id=v_source and status='settled';
      select coalesce(sum((part.value->>'recipient_net_cents')::integer),0)::integer-
        coalesce((select sum((part.value->>'recipient_net_cents')::integer)::integer
          from public.platform_hold_refund_transfer_legs l,
            lateral jsonb_array_elements(l.component_breakdown) as part(value)
          where l.hold_id=h.id and l.status='created' and part.value->>'source_id'=v_source),0)
        into v_outstanding_transfer from public.platform_hold_transfer_attempts t,
          lateral jsonb_array_elements(t.component_breakdown) as part(value)
        where t.hold_id=h.id and t.status='created' and part.value->>'source_id'=v_source;
      select (part->>'recipient_net_cents')::integer into v_refund_cash
        from jsonb_array_elements(a.held_cash_debit_components) as part
        where part->>'source_id'=v_source;
      v_refund_cash:=coalesce(v_refund_cash,0);
      v_physical_after:=(v_captured->>'recipient_net_cents')::integer-
        v_prior_refund-v_consumed-v_outstanding_transfer-v_refund_cash;
      if v_physical_after<0 or v_outstanding_transfer<0 then
        raise exception 'refunded income cannot cover reserved recovery'; end if;
      v_allocated:=0;
      for v_reserved_leg in select * from public.platform_source_consumption_legs
          where hold_id=h.id and source_component_id=v_source and
            kind='owner_debt_recovery' and status='reserved'
          order by created_at,id for update loop
        v_successor:=least(v_reserved_leg.source_net_cents,
          greatest(0,v_physical_after-v_allocated));
        if v_successor<v_reserved_leg.source_net_cents then
          update public.platform_source_consumption_legs set status='superseded',
            replacement_refund_attempt_id=a.id,updated_at=now()
            where id=v_reserved_leg.id;
          if v_successor>0 then
            insert into public.platform_source_consumption_legs
              (hold_id,source_component_id,owner_user_id,kind,source_net_cents,
               creditor_refund_attempt_id,source_charge_id,source_payment_intent_id,
               predecessor_leg_id,replacement_refund_attempt_id,attempt_key,status)
              values(h.id,v_source,v_reserved_leg.owner_user_id,'owner_debt_recovery',
                v_successor,v_reserved_leg.creditor_refund_attempt_id,
                v_reserved_leg.source_charge_id,v_reserved_leg.source_payment_intent_id,
                v_reserved_leg.id,a.id,
                'source-recovery-after-refund:'||v_reserved_leg.id::text||':'||a.id::text,
                'reserved');
          end if;
        end if;
        v_allocated:=v_allocated+v_successor;
      end loop;
    end loop;
  end if;
  if a.hold_id is not null and h.status='classified_held' then
    v_source_cash_debit:=a.held_cash_debit_cents;
    if h.amount_cents<a.hold_debit_cents or
       a.held_cash_debit_cents>a.hold_debit_cents then
      raise exception 'refund exceeds current hold'; end if;
    -- A classified wallet credit is a projection of this SAME source. Debit
    -- the exact refunded recipient NET in the hold-settlement transaction;
    -- otherwise the refunded money remains spendable after the hold shrinks.
    if h.owner_role='manager' then
      select count(*)::integer into v_mirror_count from public.proplane_balance_entries
        where source_hold_id=h.id and kind='resident_payment';
      select count(*)::integer into v_expected_mirrors
        from jsonb_array_elements(h.source_components) as c(value)
        where (c.value->>'recipient_net_cents')::integer>0;
      if v_mirror_count>0 then
        if v_mirror_count is distinct from v_expected_mirrors or
           a.recipient_debit_components is null then
          raise exception 'classified refund mirror needs source review';
        end if;
        select id into v_wallet_account from public.proplane_balance_accounts
          where owner_kind='workspace' and owner_key=a.owner_user_id::text and currency='usd'
          for update;
        if v_wallet_account is null then
          raise exception 'classified refund wallet account missing';
        end if;
        for v_component in select value from jsonb_array_elements(a.held_cash_debit_components) as value loop
          v_source:=v_component->>'source_id';
          v_net:=(v_component->>'recipient_net_cents')::integer;
          if v_net=0 then continue; end if;
          select value into v_captured from jsonb_array_elements(h.source_components) as value
            where value->>'source_id'=v_source;
          select * into v_mirror from public.proplane_balance_entries
            where source_hold_id=h.id and source_component_id=v_source for update;
          if not found or v_mirror.account_id is distinct from v_wallet_account or
             v_mirror.kind<>'resident_payment' or
             v_mirror.amount_cents is distinct from (v_captured->>'recipient_net_cents')::integer or
             v_mirror.source_liability_class is distinct from v_captured->>'liability_class' or
             v_mirror.stripe_object_id is distinct from v_charge or
             v_mirror.status not in ('pending','available') then
            raise exception 'classified refund mirror differs from captured source';
          end if;
          insert into public.proplane_balance_entries
            (account_id,amount_cents,kind,status,available_on,stripe_object_id,idempotency_key,
             source_spend_breakdown,source_income_debit_cents)
            values(v_wallet_account,-v_net,'adjustment',v_mirror.status,v_mirror.available_on,
              p_refund,'source-refund:'||a.id::text||':'||v_source,
              jsonb_build_array(jsonb_build_object('hold_id',h.id,'source_id',v_source,
                'source_net_cents',v_net)),
              case when v_captured->>'liability_class'='income' then v_net else 0 end);
        end loop;
      elsif exists(select 1 from public.proplane_balance_entries
        where kind='resident_payment' and stripe_object_id=v_charge and source_hold_id is null) then
        raise exception 'unclassified legacy balance credit needs refund review';
      end if;
    end if;
    update public.platform_payment_holds set amount_cents=amount_cents-v_source_cash_debit,
      status=case when amount_cents-v_source_cash_debit=0 then 'refunded'
        when a.transfer_reversal_cents>0 and
          amount_cents-v_source_cash_debit=a.transfer_reversal_cents then 'transferred'
        else status end,
      updated_at=now() where id=a.hold_id;
  elsif a.hold_id is not null and h.status='transferred' then
    if h.amount_cents<a.hold_debit_cents or h.stripe_transfer_id is null then
      raise exception 'recipient reversal exceeds transferred source';
    end if;
  elsif a.hold_id is not null and h.status='refunded' and a.hold_debit_cents=0 then
    null; -- The remaining manager-paid fee is a real owner debt, no hold remains.
  elsif a.hold_id is not null then
    raise exception 'refund source changed before provider settlement';
  end if;
  if a.payout_id is not null then
    update public.vendor_payouts set refunded_gross_cents=refunded_gross_cents+a.principal_cents,
      refunded_fee_cents=refunded_fee_cents+a.fee_share_cents,
      status=case when refunded_gross_cents+a.principal_cents=amount_cents then 'refunded' else 'partially_refunded' end,
      updated_at=now() where id=a.payout_id;
  end if;
  update public.platform_hold_refund_attempts set status='succeeded',stripe_refund_id=p_refund,
    settlement_allocation_mode=case when a.hold_id is null then null
      when a.held_cash_debit_cents>0 and a.transfer_reversal_cents>0 then 'mixed'
      when h.source_allocation_mode='destination' or a.transfer_reversal_cents>0 then 'transferred'
      else 'held' end,
    -- The payer's succeeded refund consumes the held recipient cash now.
    -- A transferred recipient still owns its cash until exact reversal proof.
    funded_debt_cents=case when a.hold_id is not null and
      (a.transfer_reversal_cents=0 and
       (h.source_allocation_mode='hold' or a.hold_debit_cents=0))
      then a.manager_debt_cents else 0 end,
    reversal_status=case when a.hold_id is null or
      (a.transfer_reversal_cents=0 and
       (h.source_allocation_mode='hold' or a.hold_debit_cents=0))
      then 'not_required' else 'pending' end,
    updated_at=now() where id=a.id;
  return true;
end $$;

-- A pending provider refund has a real ID but has not moved recipient money.
-- Stamp that exact ID so webhook/retry can retrieve it without another create.
create or replace function public.stamp_platform_pending_refund(
  p_attempt text,p_refund text,p_charge text,p_gross integer
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.platform_hold_refund_attempts; h public.platform_payment_holds; p public.vendor_payouts;
  v_attempt_id uuid; v_charge text;
begin
  select * into a from public.platform_hold_refund_attempts where attempt_key=p_attempt;
  if not found then raise exception 'refund attempt missing'; end if;
  v_attempt_id:=a.id; v_charge:=a.source_charge_id;
  perform pg_advisory_xact_lock(hashtextextended('platform-source-charge:'||v_charge,0));
  if a.hold_id is not null then select * into h from public.platform_payment_holds where id=a.hold_id for update; end if;
  if a.payout_id is not null then select * into p from public.vendor_payouts where id=a.payout_id for update; end if;
  select * into a from public.platform_hold_refund_attempts where attempt_key=p_attempt for update;
  if a.id is distinct from v_attempt_id or a.source_charge_id is distinct from v_charge or
     (a.hold_id is not null and h.stripe_charge_id is distinct from v_charge) or
     (a.payout_id is not null and p.stripe_charge_id is distinct from v_charge) or
     nullif(trim(p_refund),'') is null or
     a.source_charge_id is distinct from p_charge or a.gross_cents is distinct from p_gross or
     (a.stripe_refund_id is not null and a.stripe_refund_id is distinct from p_refund) then
    raise exception 'pending refund provider terms mismatch';
  end if;
  if a.status in ('succeeded','failed') then
    if a.stripe_refund_id is distinct from p_refund then
      raise exception 'pending refund provider terms mismatch';
    end if;
    return false;
  end if;
  if a.status<>'reserved' then raise exception 'pending refund status needs review'; end if;
  if a.stripe_refund_id is not null then return false; end if;
  update public.platform_hold_refund_attempts set stripe_refund_id=p_refund,
    updated_at=now() where id=a.id;
  return true;
end $$;

-- A payer refund on a destination charge is not recipient recovery. Only
-- the actual source-transfer reversal reduces the recipient allocation. The
-- provider operation must be reserved/retried under the immutable refund key
-- and verified against this exact source transfer before calling this RPC.
create or replace function public.finish_platform_transfer_reversal(
  p_attempt text,p_source_transfer text,p_reversal text,p_amount integer
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.platform_hold_refund_attempts; h public.platform_payment_holds; p public.vendor_payouts;
  v_attempt_id uuid; v_charge text;
begin
  select * into a from public.platform_hold_refund_attempts where attempt_key=p_attempt;
  if not found or a.hold_id is null then raise exception 'recipient reversal attempt missing'; end if;
  v_attempt_id:=a.id; v_charge:=a.source_charge_id;
  if a.manager_debt_cents>0 then
    perform pg_advisory_xact_lock(hashtextextended('platform-owner-recovery:'||a.owner_user_id::text,0));
  end if;
  perform pg_advisory_xact_lock(hashtextextended('platform-source-charge:'||v_charge,0));
  select * into h from public.platform_payment_holds where id=a.hold_id for update;
  if a.payout_id is not null then select * into p from public.vendor_payouts where id=a.payout_id for update; end if;
  select * into a from public.platform_hold_refund_attempts where attempt_key=p_attempt for update;
  if a.id is distinct from v_attempt_id or a.source_charge_id is distinct from v_charge or
     h.stripe_charge_id is distinct from v_charge or
     (a.payout_id is not null and p.stripe_charge_id is distinct from v_charge) or
     a.status<>'succeeded' or a.reversal_status not in ('pending','succeeded') or
     h.stripe_transfer_id is distinct from p_source_transfer or
     a.hold_debit_cents is distinct from p_amount or
     p_amount is null or p_amount<=0 or nullif(trim(p_reversal),'') is null then
    raise exception 'recipient reversal does not match refunded source';
  end if;
  if a.reversal_status='succeeded' then
    if a.stripe_reversal_id is distinct from p_reversal then
      raise exception 'recipient reversal replay changed provider leg';
    end if;
    return false;
  end if;
  if h.status<>'transferred' or h.amount_cents<p_amount then
    raise exception 'recipient allocation cannot cover reversal';
  end if;
  update public.platform_payment_holds set amount_cents=amount_cents-p_amount,
    status=case when amount_cents-p_amount=0 then 'refunded' else 'transferred' end,
    updated_at=now() where id=h.id;
  update public.platform_hold_refund_attempts set reversal_status='succeeded',
    stripe_reversal_id=p_reversal,funded_debt_cents=case when h.owner_role='manager'
      then a.manager_debt_cents else 0 end,updated_at=now() where id=a.id;
  return true;
end $$;

-- Exact per-transfer recipient recovery for a centrally captured source.
-- One refund may need several original transfer reversals; the old scalar
-- hold transfer remains only a historical receipt reference.
create or replace function public.finish_platform_refund_transfer_leg(
  p_attempt text,p_source_transfer text,p_reversal text,p_amount integer,
  p_reversed_at timestamptz
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.platform_hold_refund_attempts; h public.platform_payment_holds;
  leg public.platform_hold_refund_transfer_legs;
  source_leg public.platform_hold_transfer_attempts;
  v_charge text; v_completed integer; v_outstanding integer;
  v_expected integer; v_original_owner uuid;
begin
  select * into a from public.platform_hold_refund_attempts where attempt_key=p_attempt;
  if not found or a.hold_id is null or a.owner_user_id is null then
    raise exception 'refund transfer leg needs owned source'; end if;
  v_charge:=a.source_charge_id; v_original_owner:=a.owner_user_id;
  if a.manager_debt_cents>0 then
    perform pg_advisory_xact_lock(hashtextextended('platform-owner-recovery:'||v_original_owner::text,0));
  end if;
  perform pg_advisory_xact_lock(hashtextextended('platform-source-charge:'||v_charge,0));
  select * into h from public.platform_payment_holds where id=a.hold_id for update;
  select * into a from public.platform_hold_refund_attempts where id=a.id for update;
  select * into leg from public.platform_hold_refund_transfer_legs
    where refund_attempt_id=a.id and source_transfer_id=p_source_transfer for update;
  if not found then raise exception 'refund transfer leg is not reserved'; end if;
  select * into source_leg from public.platform_hold_transfer_attempts
    where id=leg.transfer_attempt_id for update;
  if h.owner_user_id is distinct from v_original_owner or
     h.stripe_charge_id is distinct from v_charge or
     h.source_allocation_mode is distinct from 'hold' or
     a.owner_user_id is distinct from v_original_owner or
     a.source_charge_id is distinct from v_charge or a.status<>'succeeded' or
     a.stripe_refund_id is null or a.reversal_status not in ('pending','succeeded') or
     leg.hold_id is distinct from h.id or leg.owner_user_id is distinct from v_original_owner or
     leg.source_charge_id is distinct from v_charge or leg.amount_cents is distinct from p_amount or
     leg.source_transfer_id is distinct from p_source_transfer or
     source_leg.hold_id is distinct from h.id or source_leg.status<>'created' or
     source_leg.stripe_transfer_id is distinct from p_source_transfer or
     p_amount is null or p_amount<=0 or nullif(trim(p_reversal),'') is null or
     p_reversed_at is null or leg.status='failed' or
     (select coalesce(sum((value->>'recipient_net_cents')::integer),0)::integer
      from jsonb_array_elements(leg.component_breakdown) as value) is distinct from p_amount then
    raise exception 'refund reversal differs from frozen transfer leg';
  end if;
  if leg.status='created' then
    if leg.stripe_reversal_id is distinct from p_reversal or
       leg.reversed_at is distinct from p_reversed_at then
      raise exception 'refund reversal replay changed provider leg'; end if;
    return false;
  end if;
  if h.amount_cents<p_amount or h.status not in ('classified_held','transferred') then
    raise exception 'recipient allocation cannot cover exact reversal';
  end if;
  update public.platform_hold_refund_transfer_legs set status='created',
    stripe_reversal_id=p_reversal,reversed_at=p_reversed_at,updated_at=now()
    where id=leg.id;
  select coalesce(sum(amount_cents),0)::integer into v_completed
    from public.platform_hold_refund_transfer_legs
    where refund_attempt_id=a.id and status='created';
  select coalesce(sum(created_leg.amount_cents),0)::integer-
    coalesce((select sum(reversed_leg.amount_cents)::integer
      from public.platform_hold_refund_transfer_legs reversed_leg
      where reversed_leg.hold_id=h.id and reversed_leg.status='created'),0)
    into v_outstanding from public.platform_hold_transfer_attempts created_leg
    where created_leg.hold_id=h.id and created_leg.status='created';
  if v_completed>a.transfer_reversal_cents or v_outstanding<0 or
     h.amount_cents-p_amount<v_outstanding then
    raise exception 'refund reversal exceeds frozen allocation';
  end if;
  update public.platform_payment_holds set amount_cents=amount_cents-p_amount,
    status=case when amount_cents-p_amount=0 then 'refunded'
      when amount_cents-p_amount>v_outstanding then 'classified_held' else 'transferred' end,
    updated_at=now() where id=h.id;
  if v_completed=a.transfer_reversal_cents then
    select count(*)::integer into v_expected from public.platform_hold_refund_transfer_legs
      where refund_attempt_id=a.id;
    update public.platform_hold_refund_attempts set reversal_status='succeeded',
      funded_debt_cents=case when h.owner_role='manager' then a.manager_debt_cents else 0 end,
      stripe_reversal_id=case when v_expected=1 then p_reversal else null end,
      reversal_created_at=case when v_expected=1 then p_reversed_at else null end,
      updated_at=now() where id=a.id;
  end if;
  return true;
end $$;

drop function if exists public.fail_platform_money_refund(text);
create or replace function public.fail_platform_money_refund(
  p_attempt text,p_refund text,p_terminal_status text,p_charge text,p_gross integer
)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.platform_hold_refund_attempts; h public.platform_payment_holds; p public.vendor_payouts;
  v_attempt_id uuid; v_charge text;
begin
  select * into a from public.platform_hold_refund_attempts where attempt_key=p_attempt;
  if not found then return false; end if;
  v_attempt_id:=a.id; v_charge:=a.source_charge_id;
  perform pg_advisory_xact_lock(hashtextextended('platform-source-charge:'||v_charge,0));
  if a.hold_id is not null then select * into h from public.platform_payment_holds where id=a.hold_id for update; end if;
  if a.payout_id is not null then select * into p from public.vendor_payouts where id=a.payout_id for update; end if;
  select * into a from public.platform_hold_refund_attempts where attempt_key=p_attempt for update;
  if a.id is distinct from v_attempt_id or a.source_charge_id is distinct from v_charge or
     (a.hold_id is not null and h.stripe_charge_id is distinct from v_charge) or
     (a.payout_id is not null and p.stripe_charge_id is distinct from v_charge) or
     nullif(trim(p_refund),'') is null or p_terminal_status is null or
     p_terminal_status not in ('failed','canceled') or
     a.source_charge_id is distinct from p_charge or a.gross_cents is distinct from p_gross or
     (a.stripe_refund_id is not null and a.stripe_refund_id is distinct from p_refund) then
    raise exception 'terminal refund evidence does not match reservation';
  end if;
  if a.status='failed' then
    if a.stripe_refund_id is distinct from p_refund or
       a.terminal_provider_status is distinct from p_terminal_status then
      raise exception 'failed refund replay changed provider evidence';
    end if;
    return false;
  end if;
  if a.status<>'reserved' then raise exception 'succeeded refund cannot be failed'; end if;
  update public.platform_hold_refund_attempts set status='failed',stripe_refund_id=p_refund,
    terminal_provider_status=p_terminal_status,updated_at=now() where id=a.id;
  return true;
end $$;

-- Book the payer's succeeded refund once per captured component. The ledger
-- row and its canonical refund journal are one transaction; a transferred
-- source does not credit recipient cash until its separate reversal succeeds.
-- Existing historical postings with different terms are review-gated rather
-- than silently rewritten. This routine remains uncalled until the complete
-- source/refund runtime is switched together.
create or replace function public.book_platform_refund_component(
  p_attempt text,p_component_source text,p_refunded_at timestamptz
) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.platform_hold_refund_attempts; h public.platform_payment_holds;
  v_component jsonb; v_captured jsonb; v_payment public.ledger_entries;
  v_refund public.ledger_entries; v_journal public.gl_journal_entries;
  v_principal integer; v_cash integer; v_category text; v_cash_account text;
  v_expected_count integer; v_line_count integer; v_bad_count integer;
  v_category_count integer; v_cash_count integer; v_ap_count integer;
  v_inserted_journal integer;
  v_charge text; v_refund_date date; v_source_key text;
begin
  if nullif(trim(p_attempt),'') is null or nullif(trim(p_component_source),'') is null or
     p_refunded_at is null then
    raise exception 'refund accounting requires exact attempt, component and provider date';
  end if;
  select * into a from public.platform_hold_refund_attempts where attempt_key=p_attempt;
  if not found or a.source_charge_id is null then
    raise exception 'refund accounting attempt needs source review';
  end if;
  v_charge:=a.source_charge_id;
  perform pg_advisory_xact_lock(hashtextextended('platform-source-charge:'||v_charge,0));
  if a.hold_id is not null then
    select * into h from public.platform_payment_holds where id=a.hold_id for update;
  end if;
  select * into a from public.platform_hold_refund_attempts where attempt_key=p_attempt for update;
  if a.source_charge_id is distinct from v_charge or a.status<>'succeeded' or
     nullif(trim(a.stripe_refund_id),'') is null or a.hold_id is null or
     h.owner_role is distinct from 'manager' or h.owner_user_id is distinct from a.owner_user_id or
     h.stripe_charge_id is distinct from v_charge or h.source_verified_at is null or
     jsonb_typeof(a.refund_components) is distinct from 'array' or
     jsonb_typeof(a.recipient_debit_components) is distinct from 'array' then
    raise exception 'refund accounting source needs exact manager allocation';
  end if;
  select value into v_component from jsonb_array_elements(a.recipient_debit_components) as value
    where value->>'source_id'=p_component_source;
  select value into v_captured from jsonb_array_elements(h.source_components) as value
    where value->>'source_id'=p_component_source;
  if v_component is null or v_captured is null or
     (select count(*) from jsonb_array_elements(a.recipient_debit_components) as value
       where value->>'source_id'=p_component_source)<>1 or
     (select count(*) from jsonb_array_elements(h.source_components) as value
       where value->>'source_id'=p_component_source)<>1 then
    raise exception 'refund accounting component needs exact captured source';
  end if;
  v_principal:=(v_component->>'principal_cents')::integer;
  v_cash:=case when a.settlement_allocation_mode='held'
    then (v_component->>'recipient_debit_cents')::integer
    when a.settlement_allocation_mode='mixed' then
      (select (value->>'recipient_net_cents')::integer
       from jsonb_array_elements(a.held_cash_debit_components) as value
       where value->>'source_id'=p_component_source)
    else 0 end;
  if v_principal is null or v_principal<=0 or v_cash is null or v_cash<0 or
     v_cash>v_principal or v_component->>'source_id' is distinct from p_component_source or
     a.settlement_allocation_mode is null or
     (select (value->>'principal_cents')::integer from jsonb_array_elements(a.refund_components) as value
       where value->>'source_id'=p_component_source) is distinct from v_principal or
     (v_captured->>'principal_cents')::integer<v_principal then
    raise exception 'refund accounting principal differs from captured component';
  end if;
  -- A destination source or a released hold with pending recipient reversal
  -- books the payer refund to a creditor, never to recipient cash yet.
  if a.settlement_allocation_mode='transferred' then
    v_cash:=0;
  elsif a.settlement_allocation_mode='mixed' and
    (jsonb_typeof(a.held_cash_debit_components) is distinct from 'array' or
     (select count(*) from jsonb_array_elements(a.held_cash_debit_components) as value
       where value->>'source_id'=p_component_source)<>1 or
     v_cash>(v_component->>'recipient_debit_cents')::integer) then
    raise exception 'refund accounting mixed cash vector needs review';
  elsif a.settlement_allocation_mode not in ('held','mixed') then
    raise exception 'refund accounting allocation mode needs review';
  end if;
  v_category:=case v_captured->>'kind'
    when 'rent' then 'rent_income' when 'stay_total' then 'rent_income'
    when 'first_month_rent' then 'rent_income' when 'prorated_rent' then 'rent_income'
    when 'prorated_last_month_rent' then 'rent_income'
    when 'late_fee' then 'late_fees' when 'application_fee' then 'application_fee'
    when 'holding_deposit' then 'security_deposit_liability'
    when 'security_deposit' then 'security_deposit_liability'
    when 'utilities' then 'other_income' when 'prorated_utilities' then 'other_income'
    when 'prorated_last_month_utilities' then 'other_income'
    when 'prorated_fee' then 'other_income' when 'prorated_last_month_fee' then 'other_income'
    when 'early_move_out_fee' then 'other_income' when 'move_in_fee' then 'other_income'
    when 'lease_fee' then 'other_income' when 'other_cost' then 'other_income'
    when 'payment_at_signing' then 'other_income' when 'work_order_charge' then 'other_income'
    when 'nsf_fee' then 'nsf_fees' else null end;
  if v_category is null or
     (v_category='security_deposit_liability') is distinct from
       (v_captured->>'liability_class'='deposit') then
    raise exception 'refund accounting category differs from captured liability';
  end if;
  v_cash_account:=case when v_category='security_deposit_liability'
    then 'trust_account_security_deposits' else 'operating_cash' end;
  select * into v_payment from public.ledger_entries
    where source_charge_id=p_component_source and entry_type='payment'
      and stripe_charge_id=v_charge and manager_user_id=a.owner_user_id
    for update;
  if not found or v_payment.category_code is distinct from v_category or
     v_payment.amount_cents is distinct from (v_captured->>'principal_cents')::integer then
    raise exception 'refund accounting original payment differs from captured source';
  end if;
  if a.refunded_at is null then
    update public.platform_hold_refund_attempts set refunded_at=p_refunded_at where id=a.id;
  elsif a.refunded_at is distinct from p_refunded_at then
    raise exception 'refund provider date changed on replay';
  end if;
  v_refund_date:=(p_refunded_at at time zone 'UTC')::date;
  insert into public.ledger_entries
    (manager_user_id,resident_user_id,resident_email,property_id,unit_label,lease_id,
     entry_type,category_code,amount_cents,posted_date,source_charge_id,description,
     stripe_charge_id,stripe_refund_id)
    values(v_payment.manager_user_id,v_payment.resident_user_id,v_payment.resident_email,
      v_payment.property_id,'',null,'refund',v_category,v_principal,v_refund_date,
      p_component_source,'Refund — '||p_component_source,v_charge,a.stripe_refund_id)
    on conflict (source_charge_id,entry_type,stripe_refund_id) do nothing;
  select * into v_refund from public.ledger_entries
    where source_charge_id=p_component_source and entry_type='refund'
      and stripe_refund_id=a.stripe_refund_id for update;
  if not found or v_refund.manager_user_id is distinct from v_payment.manager_user_id or
     v_refund.resident_user_id is distinct from v_payment.resident_user_id or
     v_refund.property_id is distinct from v_payment.property_id or
     v_refund.category_code is distinct from v_category or
     v_refund.amount_cents is distinct from v_principal or
     v_refund.posted_date is distinct from v_refund_date or
     v_refund.stripe_charge_id is distinct from v_charge then
    raise exception 'existing refund ledger terms need historical review';
  end if;
  v_source_key:='refund:'||p_component_source||':'||a.stripe_refund_id;
  insert into public.gl_journal_entries
    (manager_user_id,property_id,entry_date,memo,source_type,source_id)
    values(a.owner_user_id,v_payment.property_id,v_refund_date,
      'Refund '||a.stripe_refund_id,'refund',v_source_key)
    on conflict (manager_user_id,source_type,source_id) where is_reversal=false do nothing;
  get diagnostics v_inserted_journal = row_count;
  select * into v_journal from public.gl_journal_entries
    where manager_user_id=a.owner_user_id and source_type='refund'
      and source_id=v_source_key and is_reversal=false for update;
  if not found or v_journal.property_id is distinct from v_payment.property_id or
     v_journal.entry_date is distinct from v_refund_date or
     (v_refund.gl_journal_entry_id is not null and v_refund.gl_journal_entry_id is distinct from v_journal.id) then
    raise exception 'existing refund journal terms need historical review';
  end if;
  select count(*)::integer into v_line_count from public.gl_journal_lines
    where journal_entry_id=v_journal.id;
  if v_line_count=0 then
    if v_inserted_journal<>1 then
      raise exception 'existing empty refund journal needs historical review';
    end if;
    insert into public.gl_journal_lines
      (journal_entry_id,account_code,debit_cents,credit_cents,property_id,resident_user_id)
      values(v_journal.id,v_category,v_principal,0,v_payment.property_id,v_payment.resident_user_id);
    if v_cash>0 then
      insert into public.gl_journal_lines
        (journal_entry_id,account_code,debit_cents,credit_cents,property_id,resident_user_id)
        values(v_journal.id,v_cash_account,0,v_cash,v_payment.property_id,v_payment.resident_user_id);
    end if;
    if v_principal>v_cash then
      insert into public.gl_journal_lines
        (journal_entry_id,account_code,debit_cents,credit_cents,property_id,resident_user_id)
        values(v_journal.id,'accounts_payable',0,v_principal-v_cash,
          v_payment.property_id,v_payment.resident_user_id);
    end if;
  else
    v_expected_count:=1+case when v_cash>0 then 1 else 0 end+
      case when v_principal>v_cash then 1 else 0 end;
    select count(*)::integer into v_bad_count from public.gl_journal_lines l
      where l.journal_entry_id=v_journal.id and not (
        l.property_id is not distinct from v_payment.property_id and
        l.resident_user_id is not distinct from v_payment.resident_user_id and
        ((l.account_code=v_category and l.debit_cents=v_principal and l.credit_cents=0) or
         (v_cash>0 and l.account_code=v_cash_account and l.debit_cents=0 and l.credit_cents=v_cash) or
         (v_principal>v_cash and l.account_code='accounts_payable' and
          l.debit_cents=0 and l.credit_cents=v_principal-v_cash)));
    select count(*) filter (where account_code=v_category and debit_cents=v_principal and credit_cents=0),
      count(*) filter (where account_code=v_cash_account and debit_cents=0 and credit_cents=v_cash),
      count(*) filter (where account_code='accounts_payable' and debit_cents=0 and
        credit_cents=v_principal-v_cash)
      into v_category_count,v_cash_count,v_ap_count
      from public.gl_journal_lines where journal_entry_id=v_journal.id;
    if v_line_count is distinct from v_expected_count or v_bad_count<>0 or
       v_category_count<>1 or
       v_cash_count<>(case when v_cash>0 then 1 else 0 end) or
       v_ap_count<>(case when v_principal>v_cash then 1 else 0 end) or
       (select coalesce(sum(debit_cents),0) from public.gl_journal_lines
          where journal_entry_id=v_journal.id) is distinct from v_principal or
       (select coalesce(sum(credit_cents),0) from public.gl_journal_lines
          where journal_entry_id=v_journal.id) is distinct from v_principal then
      raise exception 'existing refund journal lines need historical review';
    end if;
  end if;
  update public.ledger_entries set gl_journal_entry_id=v_journal.id
    where id=v_refund.id and gl_journal_entry_id is null;
  return v_journal.id;
end $$;

-- The separate, exact recipient transfer reversal extinguishes the matching
-- part of the payer-refund creditor. It never changes the canonical refund
-- ledger row or its original journal, including while provider recovery is
-- pending or unknown.
create or replace function public.book_platform_refund_recovery_component(
  p_attempt text,p_component_source text,p_reversal_created_at timestamptz
) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.platform_hold_refund_attempts; h public.platform_payment_holds;
  v_component jsonb; v_captured jsonb; v_refund public.ledger_entries;
  v_journal public.gl_journal_entries; v_net integer; v_cash_account text;
  v_source_key text; v_refund_key text; v_charge text; v_inserted integer;
  v_line_count integer; v_bad_count integer; v_ap_count integer; v_cash_count integer;
  v_reversal_date date;
begin
  if nullif(trim(p_attempt),'') is null or nullif(trim(p_component_source),'') is null or
     p_reversal_created_at is null then
    raise exception 'recipient recovery requires exact attempt, component and provider date';
  end if;
  select * into a from public.platform_hold_refund_attempts where attempt_key=p_attempt;
  if not found or a.source_charge_id is null then
    raise exception 'recipient recovery attempt needs source review';
  end if;
  v_charge:=a.source_charge_id;
  perform pg_advisory_xact_lock(hashtextextended('platform-source-charge:'||v_charge,0));
  select * into h from public.platform_payment_holds where id=a.hold_id for update;
  select * into a from public.platform_hold_refund_attempts where attempt_key=p_attempt for update;
  if a.source_charge_id is distinct from v_charge or a.status<>'succeeded' or
     a.settlement_allocation_mode is distinct from 'transferred' or
     a.reversal_status is distinct from 'succeeded' or
     nullif(trim(a.stripe_refund_id),'') is null or
     nullif(trim(a.stripe_reversal_id),'') is null or
     h.owner_role is distinct from 'manager' or h.owner_user_id is distinct from a.owner_user_id or
     h.stripe_charge_id is distinct from v_charge or h.source_verified_at is null or
     jsonb_typeof(a.recipient_debit_components) is distinct from 'array' then
    raise exception 'recipient recovery lacks an exact transferred manager source';
  end if;
  select value into v_component from jsonb_array_elements(a.recipient_debit_components) as value
    where value->>'source_id'=p_component_source;
  select value into v_captured from jsonb_array_elements(h.source_components) as value
    where value->>'source_id'=p_component_source;
  if v_component is null or v_captured is null or
     (select count(*) from jsonb_array_elements(a.recipient_debit_components) as value
       where value->>'source_id'=p_component_source)<>1 or
     (select count(*) from jsonb_array_elements(h.source_components) as value
       where value->>'source_id'=p_component_source)<>1 then
    raise exception 'recipient recovery component needs exact captured source';
  end if;
  v_net:=(v_component->>'recipient_debit_cents')::integer;
  if v_net is null or v_net<=0 or v_net>(v_component->>'principal_cents')::integer then
    raise exception 'recipient recovery net differs from reserved source';
  end if;
  v_cash_account:=case when v_captured->>'liability_class'='deposit'
    then 'trust_account_security_deposits'
    when v_captured->>'liability_class'='income' then 'operating_cash'
    else null end;
  if v_cash_account is null then raise exception 'recipient recovery liability needs review'; end if;
  if a.reversal_created_at is null then
    update public.platform_hold_refund_attempts set reversal_created_at=p_reversal_created_at
      where id=a.id;
  elsif a.reversal_created_at is distinct from p_reversal_created_at then
    raise exception 'recipient reversal provider date changed on replay';
  end if;
  -- Recheck the whole canonical payer journal before extinguishing its AP.
  if a.refunded_at is null then raise exception 'payer refund journal date needs review'; end if;
  perform public.book_platform_refund_component(p_attempt,p_component_source,a.refunded_at);
  v_refund_key:='refund:'||p_component_source||':'||a.stripe_refund_id;
  select * into v_refund from public.ledger_entries where source_charge_id=p_component_source
    and entry_type='refund' and stripe_refund_id=a.stripe_refund_id for update;
  if not found or v_refund.manager_user_id is distinct from a.owner_user_id or
     v_refund.gl_journal_entry_id is null or not exists(
       select 1 from public.gl_journal_entries j where j.id=v_refund.gl_journal_entry_id
         and j.source_type='refund' and j.source_id=v_refund_key
         and j.manager_user_id=a.owner_user_id) then
    raise exception 'recipient recovery has no canonical payer refund journal';
  end if;
  v_reversal_date:=(p_reversal_created_at at time zone 'UTC')::date;
  v_source_key:='refund-recovery:'||p_component_source||':'||a.stripe_refund_id||':'||a.stripe_reversal_id;
  insert into public.gl_journal_entries
    (manager_user_id,property_id,entry_date,memo,source_type,source_id)
    values(a.owner_user_id,v_refund.property_id,v_reversal_date,
      'Recipient recovery '||a.stripe_reversal_id,'adjustment',v_source_key)
    on conflict (manager_user_id,source_type,source_id) where is_reversal=false do nothing;
  get diagnostics v_inserted = row_count;
  select * into v_journal from public.gl_journal_entries
    where manager_user_id=a.owner_user_id and source_type='adjustment'
      and source_id=v_source_key and is_reversal=false for update;
  if not found or v_journal.property_id is distinct from v_refund.property_id or
     v_journal.entry_date is distinct from v_reversal_date then
    raise exception 'existing recipient recovery journal needs review';
  end if;
  select count(*)::integer into v_line_count from public.gl_journal_lines
    where journal_entry_id=v_journal.id;
  if v_line_count=0 then
    if v_inserted<>1 then raise exception 'existing empty recipient recovery journal needs review'; end if;
    insert into public.gl_journal_lines
      (journal_entry_id,account_code,debit_cents,credit_cents,property_id,resident_user_id)
      values(v_journal.id,'accounts_payable',v_net,0,v_refund.property_id,v_refund.resident_user_id),
        (v_journal.id,v_cash_account,0,v_net,v_refund.property_id,v_refund.resident_user_id);
  else
    select count(*) filter (where account_code='accounts_payable' and debit_cents=v_net and credit_cents=0),
      count(*) filter (where account_code=v_cash_account and debit_cents=0 and credit_cents=v_net),
      count(*) filter (where property_id is distinct from v_refund.property_id or
        resident_user_id is distinct from v_refund.resident_user_id)
      into v_ap_count,v_cash_count,v_bad_count
      from public.gl_journal_lines where journal_entry_id=v_journal.id;
    if v_line_count<>2 or v_ap_count<>1 or v_cash_count<>1 or v_bad_count<>0 then
      raise exception 'existing recipient recovery journal lines need review';
    end if;
  end if;
  return v_journal.id;
end $$;

-- One exact completed transfer reversal books only its own recipient NET.
-- Several legs for one payer refund produce separate source/reversal journals,
-- never a second whole-principal refund or a fabricated cash receipt.
create or replace function public.book_platform_refund_transfer_recovery_component(
  p_attempt text,p_reversal text,p_component_source text
) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.platform_hold_refund_attempts; h public.platform_payment_holds;
  leg public.platform_hold_refund_transfer_legs; v_part jsonb;
  v_refund public.ledger_entries; v_journal public.gl_journal_entries;
  v_charge text; v_net integer; v_cash_account text; v_key text;
  v_inserted integer; v_line_count integer; v_ap_count integer;
  v_cash_count integer; v_bad_count integer; v_day date;
begin
  if nullif(trim(p_attempt),'') is null or nullif(trim(p_reversal),'') is null or
     nullif(trim(p_component_source),'') is null then
    raise exception 'exact transfer recovery terms are required'; end if;
  select * into a from public.platform_hold_refund_attempts where attempt_key=p_attempt;
  if not found then raise exception 'refund recovery attempt missing'; end if;
  v_charge:=a.source_charge_id;
  perform pg_advisory_xact_lock(hashtextextended('platform-source-charge:'||v_charge,0));
  select * into h from public.platform_payment_holds where id=a.hold_id for update;
  select * into a from public.platform_hold_refund_attempts where id=a.id for update;
  select * into leg from public.platform_hold_refund_transfer_legs
    where refund_attempt_id=a.id and stripe_reversal_id=p_reversal for update;
  if not found or leg.status<>'created' or leg.reversed_at is null or
     leg.hold_id is distinct from h.id or leg.owner_user_id is distinct from a.owner_user_id or
     leg.source_charge_id is distinct from v_charge or
     a.status<>'succeeded' or nullif(trim(a.stripe_refund_id),'') is null or
     a.reversal_status not in ('pending','succeeded') or
     h.owner_role is distinct from 'manager' or h.owner_user_id is distinct from a.owner_user_id or
     h.stripe_charge_id is distinct from v_charge or h.source_verified_at is null or
     h.source_allocation_mode is distinct from 'hold' then
    raise exception 'recovery has no exact completed transfer leg';
  end if;
  select value into v_part from jsonb_array_elements(leg.component_breakdown) as value
    where value->>'source_id'=p_component_source;
  if not found or (select count(*) from jsonb_array_elements(leg.component_breakdown) as value
      where value->>'source_id'=p_component_source)<>1 then
    raise exception 'recovery component is not frozen on transfer leg'; end if;
  v_net:=(v_part->>'recipient_net_cents')::integer;
  if v_net is null or v_net<=0 or
     v_net>coalesce((select (value->>'recipient_debit_cents')::integer
       from jsonb_array_elements(a.recipient_debit_components) as value
       where value->>'source_id'=p_component_source),-1) then
    raise exception 'recovery exceeds source component debit'; end if;
  if a.refunded_at is null then raise exception 'payer refund date is missing'; end if;
  perform public.book_platform_refund_component(p_attempt,p_component_source,a.refunded_at);
  select * into v_refund from public.ledger_entries where source_charge_id=p_component_source
    and entry_type='refund' and stripe_refund_id=a.stripe_refund_id for update;
  if not found or v_refund.manager_user_id is distinct from a.owner_user_id or
     v_refund.gl_journal_entry_id is null then
    raise exception 'recovery has no canonical payer refund'; end if;
  v_cash_account:=case when (select value->>'liability_class'
    from jsonb_array_elements(h.source_components) as value
    where value->>'source_id'=p_component_source)='deposit'
      then 'trust_account_security_deposits' else 'operating_cash' end;
  v_day:=(leg.reversed_at at time zone 'UTC')::date;
  v_key:='refund-recovery:'||p_component_source||':'||a.stripe_refund_id||':'||p_reversal;
  insert into public.gl_journal_entries
    (manager_user_id,property_id,entry_date,memo,source_type,source_id)
    values(a.owner_user_id,v_refund.property_id,v_day,
      'Recipient recovery '||p_reversal,'adjustment',v_key)
    on conflict (manager_user_id,source_type,source_id) where is_reversal=false do nothing;
  get diagnostics v_inserted=row_count;
  select * into v_journal from public.gl_journal_entries
    where manager_user_id=a.owner_user_id and source_type='adjustment'
      and source_id=v_key and is_reversal=false for update;
  if not found or v_journal.property_id is distinct from v_refund.property_id or
     v_journal.entry_date is distinct from v_day then
    raise exception 'recovery journal source/date changed'; end if;
  select count(*)::integer into v_line_count from public.gl_journal_lines
    where journal_entry_id=v_journal.id;
  if v_line_count=0 then
    if v_inserted<>1 then raise exception 'existing empty recovery journal needs review'; end if;
    insert into public.gl_journal_lines
      (journal_entry_id,account_code,debit_cents,credit_cents,property_id,resident_user_id)
      values(v_journal.id,'accounts_payable',v_net,0,v_refund.property_id,v_refund.resident_user_id),
        (v_journal.id,v_cash_account,0,v_net,v_refund.property_id,v_refund.resident_user_id);
  else
    select count(*) filter (where account_code='accounts_payable' and debit_cents=v_net and credit_cents=0),
      count(*) filter (where account_code=v_cash_account and debit_cents=0 and credit_cents=v_net),
      count(*) filter (where property_id is distinct from v_refund.property_id or
        resident_user_id is distinct from v_refund.resident_user_id)
      into v_ap_count,v_cash_count,v_bad_count
      from public.gl_journal_lines where journal_entry_id=v_journal.id;
    if v_line_count<>2 or v_ap_count<>1 or v_cash_count<>1 or v_bad_count<>0 then
      raise exception 'existing exact recovery journal differs'; end if;
  end if;
  return v_journal.id;
end $$;

-- Read-only gate for later same-owner recovery. A provider-funded deficit is
-- not collectible merely because its amount field was stamped: all original
-- payer and actual recipient-recovery journals must still be complete with
-- their immutable source/category/date/amount terms. Missing or historical
-- conflicting books return false; this routine never repairs them.
create or replace function public.platform_refund_accounting_complete(p_attempt uuid)
returns boolean language plpgsql stable security definer set search_path=public,pg_temp as $$
declare a public.platform_hold_refund_attempts; h public.platform_payment_holds;
  v_component jsonb; v_captured jsonb; v_debit jsonb;
  v_source text; v_principal integer; v_cash integer; v_net integer;
  v_leg_net integer; v_leg_total integer; v_held_total integer;
  v_leg public.platform_hold_refund_transfer_legs;
  v_total_principal integer:=0; v_total_debit integer:=0; v_total_debt integer:=0;
  v_category text; v_cash_account text; v_count integer;
  v_payment public.ledger_entries; v_refund public.ledger_entries;
  v_journal public.gl_journal_entries;
begin
  select * into a from public.platform_hold_refund_attempts where id=p_attempt;
  if not found or a.status<>'succeeded' or a.owner_user_id is null or
     a.funded_debt_cents<=0 or a.funded_debt_cents<=a.recovered_cents or
     a.stripe_refund_id is null or a.refunded_at is null or
     a.settlement_allocation_mode is null or
     a.settlement_allocation_mode not in ('held','transferred','mixed') or
     jsonb_typeof(a.refund_components) is distinct from 'array' or
     jsonb_typeof(a.recipient_debit_components) is distinct from 'array' or
     jsonb_array_length(a.refund_components)=0 or
     jsonb_array_length(a.refund_components) is distinct from
       jsonb_array_length(a.recipient_debit_components) then
    return false;
  end if;
  select * into h from public.platform_payment_holds where id=a.hold_id;
  if not found or h.owner_user_id is distinct from a.owner_user_id or
     h.owner_role is distinct from 'manager' or
     h.stripe_charge_id is distinct from a.source_charge_id or
     h.source_verified_at is null then return false; end if;
  -- A centrally captured source freezes its cash and every original transfer
  -- separately. The historical scalar reversal is only valid for an earlier
  -- destination allocation; it cannot stand in for several provider legs.
  if h.source_allocation_mode='hold' then
    if a.held_cash_debit_cents+a.transfer_reversal_cents is distinct from a.hold_debit_cents or
       jsonb_typeof(a.held_cash_debit_components) is distinct from 'array' or
       (a.settlement_allocation_mode='held' and a.transfer_reversal_cents<>0) or
       (a.settlement_allocation_mode='mixed' and
         (a.held_cash_debit_cents=0 or a.transfer_reversal_cents=0)) or
       (a.settlement_allocation_mode='transferred' and
         (a.held_cash_debit_cents<>0 or a.transfer_reversal_cents=0)) then return false; end if;
    select coalesce(sum(amount_cents),0)::integer into v_leg_total
      from public.platform_hold_refund_transfer_legs where refund_attempt_id=a.id;
    if v_leg_total is distinct from a.transfer_reversal_cents or
       (a.transfer_reversal_cents>0 and a.reversal_status is distinct from 'succeeded') or
       exists(select 1 from public.platform_hold_refund_transfer_legs l
         left join public.platform_hold_transfer_attempts t on t.id=l.transfer_attempt_id
         where l.refund_attempt_id=a.id and
           (l.status is distinct from 'created' or l.stripe_reversal_id is null or
            l.reversed_at is null or l.hold_id is distinct from h.id or
            l.owner_user_id is distinct from a.owner_user_id or
            l.source_charge_id is distinct from a.source_charge_id or
            t.hold_id is distinct from h.id or t.status is distinct from 'created' or
            t.stripe_transfer_id is distinct from l.source_transfer_id)) then return false; end if;
  elsif h.source_allocation_mode='destination' then
    if a.settlement_allocation_mode is distinct from 'transferred' or
       a.hold_debit_cents>0 and (a.reversal_status is distinct from 'succeeded' or
         a.stripe_reversal_id is null or a.reversal_created_at is null) or
       exists(select 1 from public.platform_hold_refund_transfer_legs
         where refund_attempt_id=a.id) then return false; end if;
  else return false;
  end if;
  for v_component in select value from jsonb_array_elements(a.refund_components) as value loop
    v_source:=v_component->>'source_id';
    v_principal:=(v_component->>'principal_cents')::integer;
    select value into v_debit from jsonb_array_elements(a.recipient_debit_components) as value
      where value->>'source_id'=v_source;
    select value into v_captured from jsonb_array_elements(h.source_components) as value
      where value->>'source_id'=v_source;
    if v_source is null or v_principal is null or v_principal<=0 or
       v_debit is null or v_captured is null or
       (v_debit->>'principal_cents')::integer is distinct from v_principal or
       (select count(*) from jsonb_array_elements(a.refund_components) as value
         where value->>'source_id'=v_source)<>1 or
       (select count(*) from jsonb_array_elements(a.recipient_debit_components) as value
         where value->>'source_id'=v_source)<>1 then return false; end if;
    v_net:=(v_debit->>'recipient_debit_cents')::integer;
    if v_net is null or v_net<0 or v_net>v_principal then return false; end if;
    if (v_debit->>'manager_debt_cents')::integer is distinct from v_principal-v_net or
       (v_captured->>'principal_cents')::integer<v_principal or
       (v_captured->>'recipient_net_cents')::integer<v_net then return false; end if;
    v_total_principal:=v_total_principal+v_principal;
    v_total_debit:=v_total_debit+v_net;
    v_total_debt:=v_total_debt+v_principal-v_net;
    if h.source_allocation_mode='hold' then
      select (value->>'recipient_net_cents')::integer into v_cash
        from jsonb_array_elements(a.held_cash_debit_components) as value
        where value->>'source_id'=v_source;
      if v_cash is null or v_cash<0 or v_cash>v_net or
         (select count(*) from jsonb_array_elements(a.held_cash_debit_components) as value
           where value->>'source_id'=v_source)<>1 then return false; end if;
      select coalesce(sum((part.value->>'recipient_net_cents')::integer),0)::integer
        into v_leg_net from public.platform_hold_refund_transfer_legs l,
          lateral jsonb_array_elements(l.component_breakdown) as part(value)
        where l.refund_attempt_id=a.id and part.value->>'source_id'=v_source;
      if v_cash+v_leg_net is distinct from v_net or
         exists(select 1 from public.platform_hold_refund_transfer_legs l,
           lateral jsonb_array_elements(l.component_breakdown) as part(value)
           where l.refund_attempt_id=a.id and part.value->>'source_id'=v_source and
             (jsonb_typeof(part.value) is distinct from 'object' or
              (part.value->>'recipient_net_cents')::integer<=0)) then return false; end if;
    else v_cash:=0; end if;
    v_held_total:=coalesce(v_held_total,0)+v_cash;
    v_category:=case v_captured->>'kind'
      when 'rent' then 'rent_income' when 'stay_total' then 'rent_income'
      when 'first_month_rent' then 'rent_income' when 'prorated_rent' then 'rent_income'
      when 'prorated_last_month_rent' then 'rent_income'
      when 'late_fee' then 'late_fees' when 'application_fee' then 'application_fee'
      when 'holding_deposit' then 'security_deposit_liability'
      when 'security_deposit' then 'security_deposit_liability'
      when 'utilities' then 'other_income' when 'prorated_utilities' then 'other_income'
      when 'prorated_last_month_utilities' then 'other_income'
      when 'prorated_fee' then 'other_income' when 'prorated_last_month_fee' then 'other_income'
      when 'early_move_out_fee' then 'other_income' when 'move_in_fee' then 'other_income'
      when 'lease_fee' then 'other_income' when 'other_cost' then 'other_income'
      when 'payment_at_signing' then 'other_income' when 'work_order_charge' then 'other_income'
      when 'nsf_fee' then 'nsf_fees' else null end;
    if v_category is null or
       (v_category='security_deposit_liability') is distinct from
         (v_captured->>'liability_class'='deposit') then return false; end if;
    v_cash_account:=case when v_category='security_deposit_liability'
      then 'trust_account_security_deposits' else 'operating_cash' end;
    select * into v_payment from public.ledger_entries where source_charge_id=v_source
      and entry_type='payment' and stripe_charge_id=a.source_charge_id;
    if not found or v_payment.manager_user_id is distinct from a.owner_user_id or
       v_payment.category_code is distinct from v_category or
       v_payment.amount_cents is distinct from (v_captured->>'principal_cents')::integer then
      return false;
    end if;
    select * into v_refund from public.ledger_entries where source_charge_id=v_source
      and entry_type='refund' and stripe_refund_id=a.stripe_refund_id;
    if not found or v_refund.manager_user_id is distinct from a.owner_user_id or
       v_refund.category_code is distinct from v_category or
       v_refund.amount_cents is distinct from v_principal or
       v_refund.posted_date is distinct from (a.refunded_at at time zone 'UTC')::date or
       v_refund.stripe_charge_id is distinct from a.source_charge_id or
       v_refund.property_id is distinct from v_payment.property_id or
       v_refund.resident_user_id is distinct from v_payment.resident_user_id or
       v_refund.gl_journal_entry_id is null then return false; end if;
    select * into v_journal from public.gl_journal_entries where id=v_refund.gl_journal_entry_id;
    if not found or v_journal.manager_user_id is distinct from a.owner_user_id or
       v_journal.source_type is distinct from 'refund' or
       v_journal.source_id is distinct from 'refund:'||v_source||':'||a.stripe_refund_id or
       v_journal.entry_date is distinct from v_refund.posted_date or
       v_journal.property_id is distinct from v_refund.property_id or
       v_journal.is_reversal then return false; end if;
    select count(*)::integer into v_count from public.gl_journal_lines
      where journal_entry_id=v_journal.id;
    if v_count is distinct from 1+(case when v_cash>0 then 1 else 0 end)+
      (case when v_principal>v_cash then 1 else 0 end) or
       (select count(*) from public.gl_journal_lines where journal_entry_id=v_journal.id
         and account_code=v_category and debit_cents=v_principal and credit_cents=0
         and property_id is not distinct from v_payment.property_id and
         resident_user_id is not distinct from v_payment.resident_user_id)<>1 or
       (select count(*) from public.gl_journal_lines where journal_entry_id=v_journal.id
         and account_code=v_cash_account and debit_cents=0 and credit_cents=v_cash
         and property_id is not distinct from v_payment.property_id and
         resident_user_id is not distinct from v_payment.resident_user_id) is distinct from
         (case when v_cash>0 then 1 else 0 end) or
       (select count(*) from public.gl_journal_lines where journal_entry_id=v_journal.id
         and account_code='accounts_payable' and debit_cents=0 and
         credit_cents=v_principal-v_cash and
         property_id is not distinct from v_payment.property_id and
         resident_user_id is not distinct from v_payment.resident_user_id) is distinct from
         (case when v_principal>v_cash then 1 else 0 end) then return false; end if;
    if h.source_allocation_mode='destination' and v_net>0 then
      select * into v_journal from public.gl_journal_entries
        where manager_user_id=a.owner_user_id and source_type='adjustment' and
          source_id='refund-recovery:'||v_source||':'||a.stripe_refund_id||':'||a.stripe_reversal_id
          and is_reversal=false;
      if not found or v_journal.entry_date is distinct from
           (a.reversal_created_at at time zone 'UTC')::date or
         v_journal.property_id is distinct from v_payment.property_id then return false; end if;
      select count(*)::integer into v_count from public.gl_journal_lines
        where journal_entry_id=v_journal.id;
      if v_count<>2 or
         (select count(*) from public.gl_journal_lines where journal_entry_id=v_journal.id
           and account_code='accounts_payable' and debit_cents=v_net and credit_cents=0
           and property_id is not distinct from v_payment.property_id and
           resident_user_id is not distinct from v_payment.resident_user_id)<>1 or
         (select count(*) from public.gl_journal_lines where journal_entry_id=v_journal.id
           and account_code=v_cash_account and debit_cents=0 and credit_cents=v_net
           and property_id is not distinct from v_payment.property_id and
           resident_user_id is not distinct from v_payment.resident_user_id)<>1 then
        return false;
      end if;
    elsif h.source_allocation_mode='hold' then
      for v_leg in select * from public.platform_hold_refund_transfer_legs l
        where l.refund_attempt_id=a.id and
          exists(select 1 from jsonb_array_elements(l.component_breakdown) as part
            where part->>'source_id'=v_source) loop
        select (part->>'recipient_net_cents')::integer into v_leg_net
          from jsonb_array_elements(v_leg.component_breakdown) as part
          where part->>'source_id'=v_source;
        if v_leg_net is null or v_leg_net<=0 or
           (select count(*) from jsonb_array_elements(v_leg.component_breakdown) as part
             where part->>'source_id'=v_source)<>1 then return false; end if;
        select * into v_journal from public.gl_journal_entries
          where manager_user_id=a.owner_user_id and source_type='adjustment' and
            source_id='refund-recovery:'||v_source||':'||a.stripe_refund_id||':'||v_leg.stripe_reversal_id
            and is_reversal=false;
        if not found or v_journal.entry_date is distinct from
             (v_leg.reversed_at at time zone 'UTC')::date or
           v_journal.property_id is distinct from v_payment.property_id then return false; end if;
        select count(*)::integer into v_count from public.gl_journal_lines
          where journal_entry_id=v_journal.id;
        if v_count<>2 or
           (select count(*) from public.gl_journal_lines where journal_entry_id=v_journal.id
             and account_code='accounts_payable' and debit_cents=v_leg_net and credit_cents=0
             and property_id is not distinct from v_payment.property_id and
             resident_user_id is not distinct from v_payment.resident_user_id)<>1 or
           (select count(*) from public.gl_journal_lines where journal_entry_id=v_journal.id
             and account_code=v_cash_account and debit_cents=0 and credit_cents=v_leg_net
             and property_id is not distinct from v_payment.property_id and
             resident_user_id is not distinct from v_payment.resident_user_id)<>1 then
          return false;
        end if;
      end loop;
    end if;
  end loop;
  if v_total_principal is distinct from a.principal_cents or
     v_total_debit is distinct from a.hold_debit_cents or
     (h.source_allocation_mode='hold' and
       v_held_total is distinct from a.held_cash_debit_cents) or
     v_total_debt is distinct from a.manager_debt_cents or
     a.funded_debt_cents is distinct from v_total_debt then return false; end if;
  return true;
end $$;

-- Reserve an established platform-funded manager creditor from an exact NEW
-- income component. This consumes no cash and does not repay AP. The owner
-- lock arbitrates two incoming sources; the sorted source locks preserve the
-- common owner -> charge -> PI -> hold -> attempt ordering.
create or replace function public.reserve_platform_owner_recovery(
  p_owner uuid,p_income_hold uuid,p_creditor uuid,p_component text,
  p_amount integer,p_attempt text
) returns public.platform_source_consumption_legs
language plpgsql security definer set search_path=public,pg_temp as $$
declare h public.platform_payment_holds; old_h public.platform_payment_holds;
  creditor public.platform_hold_refund_attempts;
  leg public.platform_source_consumption_legs;
  v_charge text; v_pi text; v_hold_id uuid; v_component jsonb;
  v_net integer; v_refunded integer; v_consumed integer; v_reserved integer;
  v_transferred integer; v_reversed integer; v_creditor_reserved integer;
  v_component_available integer; v_creditor_available integer;
begin
  if p_owner is null or p_income_hold is null or p_creditor is null or
     nullif(trim(p_component),'') is null or nullif(trim(p_attempt),'') is null or
     p_amount is null or p_amount<=0 then
    raise exception 'owner recovery source and amount are required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('platform-owner-recovery:'||p_owner::text,0));
  select * into h from public.platform_payment_holds where id=p_income_hold;
  select * into creditor from public.platform_hold_refund_attempts where id=p_creditor;
  if h.owner_user_id is distinct from p_owner or
     creditor.owner_user_id is distinct from p_owner or creditor.hold_id is null then
    raise exception 'owner recovery source or creditor missing'; end if;
  select * into old_h from public.platform_payment_holds where id=creditor.hold_id;
  if old_h.owner_user_id is distinct from p_owner or
     old_h.stripe_charge_id is distinct from creditor.source_charge_id then
    raise exception 'owner recovery creditor source changed'; end if;
  for v_charge in select distinct charge from (values(h.stripe_charge_id),
      (old_h.stripe_charge_id)) as charges(charge)
      where nullif(trim(charge),'') is not null order by charge loop
    perform pg_advisory_xact_lock(hashtextextended('platform-source-charge:'||v_charge,0));
  end loop;
  for v_pi in select distinct pi from (values(h.source_payment_intent_id),
      (old_h.source_payment_intent_id)) as intents(pi)
      where nullif(trim(pi),'') is not null order by pi loop
    perform pg_advisory_xact_lock(hashtextextended('platform-hold-pi:'||v_pi,0));
  end loop;
  for v_hold_id in select distinct id from (values(h.id),(old_h.id)) as holds(id)
      order by id loop
    perform 1 from public.platform_payment_holds where id=v_hold_id for update;
  end loop;
  select * into h from public.platform_payment_holds where id=p_income_hold;
  select * into old_h from public.platform_payment_holds where id=creditor.hold_id;
  select * into creditor from public.platform_hold_refund_attempts where id=p_creditor for update;
  if h.owner_user_id is distinct from p_owner or h.owner_role is distinct from 'manager' or
     h.source_allocation_mode is distinct from 'hold' or
     h.source_verified_at is null or nullif(trim(h.stripe_charge_id),'') is null or
     nullif(trim(h.source_payment_intent_id),'') is null or
     old_h.owner_user_id is distinct from p_owner or
     old_h.stripe_charge_id is distinct from creditor.source_charge_id or
     creditor.owner_user_id is distinct from p_owner then
    raise exception 'owner recovery needs a complete funded creditor and income source';
  end if;
  select * into leg from public.platform_source_consumption_legs
    where attempt_key=p_attempt for update;
  if found then
    if leg.kind is distinct from 'owner_debt_recovery' or leg.owner_user_id is distinct from p_owner or
       leg.hold_id is distinct from p_income_hold or leg.creditor_refund_attempt_id is distinct from p_creditor or
       leg.source_component_id is distinct from p_component or
       leg.source_net_cents is distinct from p_amount or
       leg.source_charge_id is distinct from h.stripe_charge_id or
       leg.source_payment_intent_id is distinct from h.source_payment_intent_id then
      raise exception 'owner recovery retry changed immutable source'; end if;
    return leg;
  end if;
  if h.status is distinct from 'classified_held' or creditor.status is distinct from 'succeeded' or
     not public.platform_refund_accounting_complete(creditor.id) or
     public.platform_source_has_unmapped_refund(h.stripe_charge_id) or
     exists(select 1 from public.platform_hold_transfer_attempts
       where hold_id=h.id and status='reserved') then
    raise exception 'owner recovery source or creditor is unresolved'; end if;
  select value into v_component from jsonb_array_elements(h.source_components) as value
    where value->>'source_id'=p_component;
  if not found or (select count(*) from jsonb_array_elements(h.source_components) as value
      where value->>'source_id'=p_component)<>1 or
     v_component->>'liability_class' is distinct from 'income' then
    raise exception 'owner recovery may consume exact income only'; end if;
  v_net:=(v_component->>'recipient_net_cents')::integer;
  select coalesce(sum((part.value->>'recipient_debit_cents')::integer),0)::integer
    into v_refunded from public.platform_hold_refund_attempts a,
      lateral jsonb_array_elements(a.recipient_debit_components) as part(value)
    where a.hold_id=h.id and a.status='succeeded' and part.value->>'source_id'=p_component;
  select coalesce(sum(source_net_cents) filter (where status='settled'),0)::integer,
    coalesce(sum(source_net_cents) filter (where status='reserved'),0)::integer
    into v_consumed,v_reserved from public.platform_source_consumption_legs
    where hold_id=h.id and source_component_id=p_component;
  select coalesce(sum((part.value->>'recipient_net_cents')::integer),0)::integer
    into v_transferred from public.platform_hold_transfer_attempts t,
      lateral jsonb_array_elements(t.component_breakdown) as part(value)
    where t.hold_id=h.id and t.status='created' and part.value->>'source_id'=p_component;
  select coalesce(sum((part.value->>'recipient_net_cents')::integer),0)::integer
    into v_reversed from public.platform_hold_refund_transfer_legs l,
      lateral jsonb_array_elements(l.component_breakdown) as part(value)
    where l.hold_id=h.id and l.status='created' and part.value->>'source_id'=p_component;
  v_component_available:=v_net-v_refunded-v_consumed-v_reserved-v_transferred+v_reversed;
  select coalesce(sum(source_net_cents),0)::integer into v_creditor_reserved
    from public.platform_source_consumption_legs
    where creditor_refund_attempt_id=creditor.id and kind='owner_debt_recovery' and status='reserved';
  v_creditor_available:=creditor.funded_debt_cents-creditor.recovered_cents-v_creditor_reserved;
  if v_net is null or v_component_available<p_amount or v_creditor_available<p_amount or
     v_component_available<0 or v_creditor_available<0 or
     exists(select 1 from public.platform_hold_refund_attempts
       where hold_id=h.id and status='reserved') or
     exists(select 1 from public.platform_source_consumption_legs
       where hold_id=h.id and source_component_id=p_component and kind='owner_debt_recovery'
         and creditor_refund_attempt_id=creditor.id) then
    raise exception 'owner recovery exceeds unreserved eligible income or creditor'; end if;
  insert into public.platform_source_consumption_legs
    (hold_id,source_component_id,owner_user_id,kind,source_net_cents,
     creditor_refund_attempt_id,source_charge_id,source_payment_intent_id,
     attempt_key,status)
    values(h.id,p_component,p_owner,'owner_debt_recovery',p_amount,
      creditor.id,h.stripe_charge_id,h.source_payment_intent_id,p_attempt,'reserved')
    returning * into leg;
  return leg;
end $$;

-- A reserved owner offset becomes real AP repayment only after the caller has
-- freshly re-read this exact succeeded USD charge/PI and its actual Stripe
-- balance transaction. Unknown or future clearing is a durable reservation,
-- not cash, a journal, or a change to the creditor's recovered balance.
create or replace function public.settle_platform_owner_recovery(
  p_attempt text,p_charge text,p_payment_intent text,
  p_balance_transaction text,p_available_on timestamptz,p_attested_at timestamptz
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare leg public.platform_source_consumption_legs;
  h public.platform_payment_holds; old_h public.platform_payment_holds;
  creditor public.platform_hold_refund_attempts;
  payment public.ledger_entries; charge_entry public.ledger_entries;
  journal public.gl_journal_entries; origin_journal public.gl_journal_entries;
  mirror public.proplane_balance_entries; v_account uuid; v_component jsonb;
  v_charge text; v_pi text; v_hold_id uuid; v_journal_key text;
  v_inserted integer; v_line_count integer; v_ap_count integer; v_cash_count integer;
  v_refunded integer; v_consumed integer; v_reserved integer;
  v_remaining integer; v_outstanding_transfer integer; v_component_transfer integer;
  v_component_reversed integer; v_all_net integer; v_all_refunded integer;
  v_all_consumed integer; v_mirror_count integer;
begin
  if nullif(trim(p_attempt),'') is null or nullif(trim(p_charge),'') is null or
     nullif(trim(p_payment_intent),'') is null or
     nullif(trim(p_balance_transaction),'') is null or p_available_on is null or
     p_attested_at is null or p_available_on>now() or
     p_attested_at<now()-interval '5 minutes' or
     p_attested_at>now()+interval '1 minute' then
    raise exception 'owner recovery requires fresh cleared provider evidence'; end if;
  select * into leg from public.platform_source_consumption_legs where attempt_key=p_attempt;
  if not found or leg.kind is distinct from 'owner_debt_recovery' or
     leg.owner_user_id is null or leg.creditor_refund_attempt_id is null then
    raise exception 'owner recovery reservation missing'; end if;
  perform pg_advisory_xact_lock(hashtextextended('platform-owner-recovery:'||leg.owner_user_id::text,0));
  select * into h from public.platform_payment_holds where id=leg.hold_id;
  select * into creditor from public.platform_hold_refund_attempts where id=leg.creditor_refund_attempt_id;
  select * into old_h from public.platform_payment_holds where id=creditor.hold_id;
  for v_charge in select distinct charge from (values(h.stripe_charge_id),
      (old_h.stripe_charge_id)) as charges(charge)
      where nullif(trim(charge),'') is not null order by charge loop
    perform pg_advisory_xact_lock(hashtextextended('platform-source-charge:'||v_charge,0));
  end loop;
  for v_pi in select distinct pi from (values(h.source_payment_intent_id),
      (old_h.source_payment_intent_id)) as intents(pi)
      where nullif(trim(pi),'') is not null order by pi loop
    perform pg_advisory_xact_lock(hashtextextended('platform-hold-pi:'||v_pi,0));
  end loop;
  for v_hold_id in select distinct id from (values(h.id),(old_h.id)) as holds(id)
      order by id loop
    perform 1 from public.platform_payment_holds where id=v_hold_id for update;
  end loop;
  select * into h from public.platform_payment_holds where id=leg.hold_id;
  select * into old_h from public.platform_payment_holds where id=creditor.hold_id;
  select * into creditor from public.platform_hold_refund_attempts
    where id=leg.creditor_refund_attempt_id for update;
  select * into leg from public.platform_source_consumption_legs
    where attempt_key=p_attempt for update;
  if leg.owner_user_id is null or h.owner_user_id is distinct from leg.owner_user_id or
     old_h.owner_user_id is distinct from leg.owner_user_id or
     creditor.owner_user_id is distinct from leg.owner_user_id or
     h.owner_role is distinct from 'manager' or
     h.source_allocation_mode is distinct from 'hold' or h.source_verified_at is null or
     h.stripe_charge_id is distinct from p_charge or
     h.source_payment_intent_id is distinct from p_payment_intent or
     leg.source_charge_id is distinct from p_charge or
     leg.source_payment_intent_id is distinct from p_payment_intent or
     old_h.stripe_charge_id is distinct from creditor.source_charge_id or
     leg.source_net_cents<=0 then
    raise exception 'owner recovery source or creditor changed'; end if;
  select value into v_component from jsonb_array_elements(h.source_components) as value
    where value->>'source_id'=leg.source_component_id;
  if not found or (select count(*) from jsonb_array_elements(h.source_components) as value
      where value->>'source_id'=leg.source_component_id)<>1 or
     v_component->>'liability_class' is distinct from 'income' or
     leg.source_net_cents>(v_component->>'recipient_net_cents')::integer then
    raise exception 'owner recovery no longer has captured income'; end if;
  select * into payment from public.ledger_entries
    where source_charge_id=leg.source_component_id and entry_type='payment'
      and stripe_charge_id=p_charge for update;
  if not found or payment.manager_user_id is distinct from leg.owner_user_id or
     payment.amount_cents is distinct from (v_component->>'principal_cents')::integer or
     payment.gl_journal_entry_id is null or
     payment.category_code is distinct from (case v_component->>'kind'
       when 'rent' then 'rent_income' when 'stay_total' then 'rent_income'
       when 'first_month_rent' then 'rent_income' when 'prorated_rent' then 'rent_income'
       when 'prorated_last_month_rent' then 'rent_income'
       when 'late_fee' then 'late_fees' when 'application_fee' then 'application_fee'
       when 'nsf_fee' then 'nsf_fees' else 'other_income' end) then
    raise exception 'owner recovery needs originating income books'; end if;
  select * into origin_journal from public.gl_journal_entries
    where id=payment.gl_journal_entry_id;
  select count(*)::integer,
    count(*) filter (where account_code='operating_cash' and
      debit_cents=payment.amount_cents and credit_cents=0 and
      property_id is not distinct from payment.property_id and
      resident_user_id is not distinct from payment.resident_user_id),
    count(*) filter (where account_code='accounts_receivable' and
      debit_cents=0 and credit_cents=payment.amount_cents and
      property_id is not distinct from payment.property_id and
      resident_user_id is not distinct from payment.resident_user_id)
    into v_line_count,v_cash_count,v_ap_count from public.gl_journal_lines
    where journal_entry_id=origin_journal.id;
  if origin_journal.id is null or
     origin_journal.manager_user_id is distinct from leg.owner_user_id or
     origin_journal.property_id is distinct from payment.property_id or
     origin_journal.source_type is distinct from 'payment' or
     origin_journal.source_id is distinct from leg.source_component_id or
     origin_journal.is_reversal or v_line_count<>2 or
     v_cash_count<>1 or v_ap_count<>1 then
    raise exception 'owner recovery needs complete originating payment books'; end if;
  select * into charge_entry from public.ledger_entries
    where source_charge_id=leg.source_component_id and entry_type='charge'
      and manager_user_id=leg.owner_user_id;
  if not found or charge_entry.category_code is distinct from payment.category_code or
     charge_entry.amount_cents is distinct from payment.amount_cents or
     charge_entry.property_id is distinct from payment.property_id or
     charge_entry.resident_user_id is distinct from payment.resident_user_id or
     charge_entry.gl_journal_entry_id is null then
    raise exception 'owner recovery needs originating charge books'; end if;
  select * into origin_journal from public.gl_journal_entries
    where id=charge_entry.gl_journal_entry_id;
  select count(*)::integer,
    count(*) filter (where account_code='accounts_receivable' and
      debit_cents=charge_entry.amount_cents and credit_cents=0 and
      property_id is not distinct from charge_entry.property_id and
      resident_user_id is not distinct from charge_entry.resident_user_id),
    count(*) filter (where account_code=charge_entry.category_code and
      debit_cents=0 and credit_cents=charge_entry.amount_cents and
      property_id is not distinct from charge_entry.property_id and
      resident_user_id is not distinct from charge_entry.resident_user_id)
    into v_line_count,v_ap_count,v_cash_count from public.gl_journal_lines
    where journal_entry_id=origin_journal.id;
  if origin_journal.id is null or
     origin_journal.manager_user_id is distinct from leg.owner_user_id or
     origin_journal.property_id is distinct from charge_entry.property_id or
     origin_journal.source_type is distinct from 'charge' or
     origin_journal.source_id is distinct from leg.source_component_id or
     origin_journal.is_reversal or v_line_count<>2 or
     v_ap_count<>1 or v_cash_count<>1 then
    raise exception 'owner recovery needs complete originating charge books'; end if;
  if leg.status='settled' then
    select * into journal from public.gl_journal_entries where id=leg.recovery_journal_id;
    select count(*)::integer,
      count(*) filter (where account_code='accounts_payable' and
        debit_cents=leg.source_net_cents and credit_cents=0 and
        property_id is not distinct from payment.property_id and
        resident_user_id is not distinct from payment.resident_user_id),
      count(*) filter (where account_code='operating_cash' and
        debit_cents=0 and credit_cents=leg.source_net_cents and
        property_id is not distinct from payment.property_id and
        resident_user_id is not distinct from payment.resident_user_id)
      into v_line_count,v_ap_count,v_cash_count from public.gl_journal_lines
      where journal_entry_id=journal.id;
    if leg.source_balance_transaction_id is distinct from p_balance_transaction or
       leg.source_available_on is distinct from p_available_on or
       leg.recovered_at is null or journal.id is null or
       journal.manager_user_id is distinct from leg.owner_user_id or
       journal.source_type is distinct from 'adjustment' or
       journal.source_id is distinct from 'owner-recovery:'||leg.id::text or
       journal.property_id is distinct from payment.property_id or
       v_line_count<>2 or v_ap_count<>1 or v_cash_count<>1 then
      raise exception 'owner recovery replay changed provider or journal terms'; end if;
    return false;
  end if;
  if leg.status<>'reserved' or h.status is distinct from 'classified_held' or
     h.amount_cents<leg.source_net_cents or
     not public.platform_refund_accounting_complete(creditor.id) or
     public.platform_source_has_unmapped_refund(p_charge) or
     exists(select 1 from public.platform_hold_refund_attempts
       where hold_id=h.id and
         (status='reserved' or
          (status='succeeded' and reversal_status in ('pending','shortfall')))) then
    raise exception 'owner recovery source is not cleared and unrefunded'; end if;
  select coalesce(sum((part.value->>'recipient_debit_cents')::integer),0)::integer
    into v_refunded from public.platform_hold_refund_attempts a,
      lateral jsonb_array_elements(a.recipient_debit_components) as part(value)
    where a.hold_id=h.id and a.status='succeeded' and
      part.value->>'source_id'=leg.source_component_id;
  select coalesce(sum(source_net_cents) filter (where status='settled'),0)::integer,
    coalesce(sum(source_net_cents) filter (where status='reserved'),0)::integer
    into v_consumed,v_reserved from public.platform_source_consumption_legs
    where hold_id=h.id and source_component_id=leg.source_component_id;
  select coalesce(sum((part.value->>'recipient_net_cents')::integer),0)::integer
    into v_component_transfer from public.platform_hold_transfer_attempts t,
      lateral jsonb_array_elements(t.component_breakdown) as part(value)
    where t.hold_id=h.id and t.status='created' and
      part.value->>'source_id'=leg.source_component_id;
  select coalesce(sum((part.value->>'recipient_net_cents')::integer),0)::integer
    into v_component_reversed from public.platform_hold_refund_transfer_legs r,
      lateral jsonb_array_elements(r.component_breakdown) as part(value)
    where r.hold_id=h.id and r.status='created' and
      part.value->>'source_id'=leg.source_component_id;
  select coalesce(sum(t.amount_cents),0)::integer-
    coalesce((select sum(r.amount_cents)::integer from public.platform_hold_refund_transfer_legs r
      where r.hold_id=h.id and r.status='created'),0)
    into v_outstanding_transfer from public.platform_hold_transfer_attempts t
    where t.hold_id=h.id and t.status='created';
  select coalesce(sum((part.value->>'recipient_net_cents')::integer),0)::integer
    into v_all_net from jsonb_array_elements(h.source_components) as part(value);
  select coalesce(sum((part.value->>'recipient_debit_cents')::integer),0)::integer
    into v_all_refunded from public.platform_hold_refund_attempts a,
      lateral jsonb_array_elements(a.recipient_debit_components) as part(value)
    where a.hold_id=h.id and a.status='succeeded';
  select coalesce(sum(source_net_cents),0)::integer into v_all_consumed
    from public.platform_source_consumption_legs where hold_id=h.id and status='settled';
  v_remaining:=(v_component->>'recipient_net_cents')::integer-v_refunded-v_consumed-v_reserved;
  if v_remaining<0 or v_outstanding_transfer<0 or
     v_component_transfer<v_component_reversed or
     h.amount_cents is distinct from v_all_net-v_all_refunded-v_all_consumed or
     v_component_transfer-v_component_reversed>v_remaining or
     v_outstanding_transfer>h.amount_cents-leg.source_net_cents or
     creditor.funded_debt_cents-creditor.recovered_cents<leg.source_net_cents then
    raise exception 'owner recovery allocation is not conserved'; end if;
  select count(*)::integer into v_mirror_count from public.proplane_balance_entries
    where source_hold_id=h.id and kind='resident_payment';
  if v_mirror_count>0 then
    select id into v_account from public.proplane_balance_accounts
      where owner_kind='workspace' and owner_key=leg.owner_user_id::text and currency='usd'
      for update;
    select * into mirror from public.proplane_balance_entries
      where source_hold_id=h.id and source_component_id=leg.source_component_id for update;
    if v_account is null or mirror.account_id is distinct from v_account or
       mirror.kind is distinct from 'resident_payment' or
       mirror.amount_cents is distinct from (v_component->>'recipient_net_cents')::integer or
       mirror.source_liability_class is distinct from 'income' or
       mirror.stripe_object_id is distinct from p_charge or
       mirror.status not in ('pending','available') then
      raise exception 'owner recovery mirror differs from captured income'; end if;
  end if;
  v_journal_key:='owner-recovery:'||leg.id::text;
  insert into public.gl_journal_entries
    (manager_user_id,property_id,entry_date,memo,source_type,source_id)
    values(leg.owner_user_id,payment.property_id,(now() at time zone 'UTC')::date,
      'Recovered platform-funded refund from income','adjustment',v_journal_key)
    on conflict (manager_user_id,source_type,source_id) where is_reversal=false do nothing;
  get diagnostics v_inserted=row_count;
  select * into journal from public.gl_journal_entries
    where manager_user_id=leg.owner_user_id and source_type='adjustment'
      and source_id=v_journal_key and is_reversal=false for update;
  if not found or v_inserted<>1 or journal.property_id is distinct from payment.property_id or
     journal.entry_date is distinct from (now() at time zone 'UTC')::date then
    raise exception 'owner recovery journal already differs'; end if;
  insert into public.gl_journal_lines
    (journal_entry_id,account_code,debit_cents,credit_cents,property_id,resident_user_id)
    values(journal.id,'accounts_payable',leg.source_net_cents,0,
      payment.property_id,payment.resident_user_id),
      (journal.id,'operating_cash',0,leg.source_net_cents,
      payment.property_id,payment.resident_user_id);
  if v_mirror_count>0 then
    update public.proplane_balance_entries set available_on=p_available_on
      where id=mirror.id and available_on is null;
    insert into public.proplane_balance_entries
      (account_id,amount_cents,kind,status,available_on,stripe_object_id,
       idempotency_key,source_spend_breakdown,source_income_debit_cents)
      values(v_account,-leg.source_net_cents,'adjustment',mirror.status,p_available_on,
        p_charge,'source-recovery:'||leg.id::text,
        jsonb_build_array(jsonb_build_object('hold_id',h.id,
          'source_id',leg.source_component_id,'source_net_cents',leg.source_net_cents)),
        leg.source_net_cents) returning id into leg.wallet_debit_entry_id;
  end if;
  update public.platform_payment_holds set amount_cents=amount_cents-leg.source_net_cents,
    status=case when amount_cents-leg.source_net_cents=v_outstanding_transfer
      then 'transferred' else 'classified_held' end,updated_at=now() where id=h.id;
  update public.platform_hold_refund_attempts
    set recovered_cents=recovered_cents+leg.source_net_cents,updated_at=now()
    where id=creditor.id;
  update public.platform_source_consumption_legs set status='settled',
    source_balance_transaction_id=p_balance_transaction,
    source_available_on=p_available_on,source_attested_at=p_attested_at,
    recovered_at=now(),recovery_journal_id=journal.id,
    wallet_debit_entry_id=leg.wallet_debit_entry_id,updated_at=now()
    where id=leg.id;
  return true;
end $$;

-- Credit, same-owner debt reservation and the classified balance projection
-- are one visible transaction. No caller may expose a fresh manager income
-- source between credit and its established creditor reservations.
create or replace function public.credit_platform_income_with_recovery(
  p_owner uuid,p_source text,p_source_id text,p_charge text,p_payment_intent text,
  p_charge_gross integer,p_principal integer,p_original_net integer,
  p_fee_payer text,p_components jsonb,p_available_on timestamptz default null
) returns table(hold_id uuid,credited boolean,reserved_cents integer)
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_credit record; h public.platform_payment_holds;
  creditor public.platform_hold_refund_attempts; v_component jsonb;
  v_charge text; v_pi text; v_hold_id uuid; v_attempt_id uuid;
  v_source text; v_net integer; v_free integer; v_debt integer;
  v_refunded integer; v_consumed integer; v_transferred integer; v_reversed integer;
  v_account uuid; v_mirror public.proplane_balance_entries;
  v_existing integer; v_expected integer:=0; v_reserved integer:=0;
begin
  if p_owner is null or nullif(trim(p_charge),'') is null or
     nullif(trim(p_payment_intent),'') is null or
     jsonb_typeof(p_components) is distinct from 'array' then
    raise exception 'classified income source is incomplete'; end if;
  perform pg_advisory_xact_lock(hashtextextended('platform-owner-recovery:'||p_owner::text,0));
  -- Prelock both new and established creditor sources in the shared order.
  for v_charge in select distinct charge from (
      select p_charge as charge union all
      select old.stripe_charge_id from public.platform_hold_refund_attempts a
        join public.platform_payment_holds old on old.id=a.hold_id
        where a.owner_user_id=p_owner and old.owner_user_id=p_owner and
          a.status='succeeded' and a.funded_debt_cents>a.recovered_cents
    ) as charges where nullif(trim(charge),'') is not null order by charge loop
    perform pg_advisory_xact_lock(hashtextextended('platform-source-charge:'||v_charge,0));
  end loop;
  for v_pi in select distinct pi from (
      select p_payment_intent as pi union all
      select old.source_payment_intent_id from public.platform_hold_refund_attempts a
        join public.platform_payment_holds old on old.id=a.hold_id
        where a.owner_user_id=p_owner and old.owner_user_id=p_owner and
          a.status='succeeded' and a.funded_debt_cents>a.recovered_cents
    ) as intents where nullif(trim(pi),'') is not null order by pi loop
    perform pg_advisory_xact_lock(hashtextextended('platform-hold-pi:'||v_pi,0));
  end loop;
  for v_hold_id in select distinct old.id from public.platform_hold_refund_attempts a
      join public.platform_payment_holds old on old.id=a.hold_id
      where a.owner_user_id=p_owner and old.owner_user_id=p_owner and
        a.status='succeeded' and a.funded_debt_cents>a.recovered_cents
      order by old.id loop
    perform 1 from public.platform_payment_holds where id=v_hold_id for update;
  end loop;
  for v_attempt_id in select a.id from public.platform_hold_refund_attempts a
      where a.owner_user_id=p_owner and a.status='succeeded' and
        a.funded_debt_cents>a.recovered_cents order by a.id loop
    perform 1 from public.platform_hold_refund_attempts where id=v_attempt_id for update;
  end loop;
  select * into v_credit from public.credit_verified_platform_hold(
    p_owner,'manager',p_source,p_source_id,p_charge,p_payment_intent,
    p_charge_gross,p_principal,p_original_net,p_fee_payer,p_components);
  select * into h from public.platform_payment_holds where id=v_credit.hold_id for update;
  if h.owner_user_id is distinct from p_owner or h.owner_role is distinct from 'manager' or
     h.source_allocation_mode is distinct from 'hold' or
     h.stripe_charge_id is distinct from p_charge or
     h.source_payment_intent_id is distinct from p_payment_intent then
    raise exception 'classified income source changed before recovery'; end if;
  for v_component in select value from jsonb_array_elements(h.source_components) as value
      order by value->>'source_id' loop
    if v_component->>'liability_class' <> 'income' then continue; end if;
    v_source:=v_component->>'source_id';
    v_net:=(v_component->>'recipient_net_cents')::integer;
    select coalesce(sum((part.value->>'recipient_debit_cents')::integer),0)::integer
      into v_refunded from public.platform_hold_refund_attempts a,
        lateral jsonb_array_elements(a.recipient_debit_components) as part(value)
      where a.hold_id=h.id and a.status='succeeded' and part.value->>'source_id'=v_source;
    select coalesce(sum(consumed.source_net_cents),0)::integer into v_consumed
      from public.platform_source_consumption_legs consumed
      where consumed.hold_id=h.id and consumed.source_component_id=v_source and
        consumed.status in ('reserved','settled');
    select coalesce(sum((part.value->>'recipient_net_cents')::integer),0)::integer
      into v_transferred from public.platform_hold_transfer_attempts t,
        lateral jsonb_array_elements(t.component_breakdown) as part(value)
      where t.hold_id=h.id and t.status='created' and part.value->>'source_id'=v_source;
    select coalesce(sum((part.value->>'recipient_net_cents')::integer),0)::integer
      into v_reversed from public.platform_hold_refund_transfer_legs r,
        lateral jsonb_array_elements(r.component_breakdown) as part(value)
      where r.hold_id=h.id and r.status='created' and part.value->>'source_id'=v_source;
    v_free:=v_net-v_refunded-v_consumed-v_transferred+v_reversed;
    if v_free<0 then raise exception 'classified income source is overallocated'; end if;
    for creditor in select a.* from public.platform_hold_refund_attempts a
        join public.platform_payment_holds old on old.id=a.hold_id
        where a.owner_user_id=p_owner and old.owner_user_id=p_owner and
          old.id<>h.id and a.status='succeeded' and
          a.funded_debt_cents>a.recovered_cents and
          public.platform_refund_accounting_complete(a.id)
        order by a.created_at,a.id loop
      exit when v_free=0;
      select creditor.funded_debt_cents-creditor.recovered_cents-
        coalesce(sum(existing.source_net_cents),0)::integer into v_debt
        from public.platform_source_consumption_legs existing
        where existing.creditor_refund_attempt_id=creditor.id and
          existing.kind='owner_debt_recovery' and existing.status='reserved';
      if v_debt<=0 or exists(select 1 from public.platform_source_consumption_legs existing
          where existing.hold_id=h.id and existing.source_component_id=v_source and
            existing.kind='owner_debt_recovery' and
            existing.creditor_refund_attempt_id=creditor.id) then
        continue; end if;
      perform public.reserve_platform_owner_recovery(p_owner,h.id,creditor.id,v_source,
        least(v_free,v_debt),'owner-recovery:'||h.id::text||':'||v_source||':'||creditor.id::text);
      v_reserved:=v_reserved+least(v_free,v_debt);
      v_free:=v_free-least(v_free,v_debt);
    end loop;
  end loop;
  -- The mirror is last: its account lock cannot precede creditor attempt
  -- locks, and the transaction commits only with every reservation complete.
  v_account:=public.proplane_balance_ensure_account('workspace',p_owner::text,'usd');
  perform 1 from public.proplane_balance_accounts where id=v_account for update;
  if exists(select 1 from public.proplane_balance_entries
    where kind='resident_payment' and stripe_object_id=p_charge and source_hold_id is null) then
    raise exception 'captured charge has an unclassified legacy balance credit'; end if;
  select count(*)::integer into v_existing from public.proplane_balance_entries
    where source_hold_id=h.id and kind='resident_payment';
  for v_component in select value from jsonb_array_elements(h.source_components) as value loop
    v_source:=v_component->>'source_id';
    v_net:=(v_component->>'recipient_net_cents')::integer;
    if v_net=0 then continue; end if;
    v_expected:=v_expected+1;
    select * into v_mirror from public.proplane_balance_entries
      where source_hold_id=h.id and source_component_id=v_source for update;
    if found then
      if v_credit.credited or v_mirror.account_id is distinct from v_account or
         v_mirror.kind<>'resident_payment' or v_mirror.amount_cents is distinct from v_net or
         v_mirror.source_liability_class is distinct from v_component->>'liability_class' or
         v_mirror.stripe_object_id is distinct from p_charge or
         v_mirror.idempotency_key is distinct from
           'source-mirror:'||h.id::text||':'||v_source or
         (v_mirror.available_on is not null and p_available_on is not null and
          v_mirror.available_on is distinct from p_available_on) then
        raise exception 'classified balance mirror changed immutable source'; end if;
      if v_mirror.available_on is null and p_available_on is not null then
        update public.proplane_balance_entries set available_on=p_available_on where id=v_mirror.id;
        -- A pending release/refund debit cancels this same source component.
        -- Hydrating the credit alone would make already-allocated money spendable.
        update public.proplane_balance_entries set available_on=p_available_on
          where account_id=v_account and amount_cents<0 and kind='adjustment' and
            status='pending' and available_on is null and
            source_spend_breakdown @> jsonb_build_array(jsonb_build_object(
              'hold_id',h.id,'source_id',v_source));
      end if;
    else
      if not v_credit.credited or v_existing<>0 then
        raise exception 'existing source lacks an exact classified mirror'; end if;
      insert into public.proplane_balance_entries
        (account_id,amount_cents,kind,status,available_on,stripe_object_id,
         idempotency_key,source_hold_id,source_component_id,source_liability_class)
        values(v_account,v_net,'resident_payment','pending',p_available_on,p_charge,
          'source-mirror:'||h.id::text||':'||v_source,h.id,v_source,
          v_component->>'liability_class');
    end if;
  end loop;
  if not v_credit.credited and v_existing is distinct from v_expected then
    raise exception 'classified balance mirror is incomplete'; end if;
  hold_id:=h.id; credited:=v_credit.credited; reserved_cents:=v_reserved;
  return next;
end $$;

revoke all on function public.verify_platform_hold_source(uuid,uuid,text,text,integer,integer,integer,text,text,text,integer,integer,text,jsonb) from public,anon,authenticated;
revoke all on function public.record_platform_source_refund_evidence(text,text,text,integer,text) from public,anon,authenticated;
revoke all on function public.platform_source_has_unmapped_refund(text) from public,anon,authenticated;
revoke all on function public.credit_verified_platform_hold(uuid,text,text,text,text,text,integer,integer,integer,text,jsonb,text,text,integer,integer,text) from public,anon,authenticated;
revoke all on function public.credit_verified_platform_income_mirror(uuid,text,text,text,text,integer,integer,integer,text,jsonb,timestamptz) from public,anon,authenticated;
revoke all on function public.reserve_platform_hold_transfer(uuid,uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.finish_platform_hold_transfer(uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.read_platform_hold_owner_funds(uuid) from public,anon,authenticated;
revoke all on function public.platform_balance_move_from_sources(uuid,uuid,bigint,text,jsonb) from public,anon,authenticated;
revoke all on function public.reserve_platform_money_refund(uuid,text,integer,uuid,uuid,integer,text,boolean,boolean,jsonb) from public,anon,authenticated;
revoke all on function public.finish_platform_money_refund(text,text,integer) from public,anon,authenticated;
revoke all on function public.stamp_platform_pending_refund(text,text,text,integer) from public,anon,authenticated;
revoke all on function public.finish_platform_transfer_reversal(text,text,text,integer) from public,anon,authenticated;
revoke all on function public.finish_platform_refund_transfer_leg(text,text,text,integer,timestamptz) from public,anon,authenticated;
revoke all on function public.fail_platform_money_refund(text,text,text,text,integer) from public,anon,authenticated;
revoke all on function public.book_platform_refund_component(text,text,timestamptz) from public,anon,authenticated;
revoke all on function public.book_platform_refund_recovery_component(text,text,timestamptz) from public,anon,authenticated;
revoke all on function public.book_platform_refund_transfer_recovery_component(text,text,text) from public,anon,authenticated;
revoke all on function public.platform_refund_accounting_complete(uuid) from public,anon,authenticated;
revoke all on function public.reserve_platform_owner_recovery(uuid,uuid,uuid,text,integer,text) from public,anon,authenticated;
revoke all on function public.settle_platform_owner_recovery(text,text,text,text,timestamptz,timestamptz) from public,anon,authenticated;
revoke all on function public.credit_platform_income_with_recovery(uuid,text,text,text,text,integer,integer,integer,text,jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.verify_platform_hold_source(uuid,uuid,text,text,integer,integer,integer,text,text,text,integer,integer,text,jsonb) to service_role;
grant execute on function public.record_platform_source_refund_evidence(text,text,text,integer,text) to service_role;
grant execute on function public.platform_source_has_unmapped_refund(text) to service_role;
grant execute on function public.credit_verified_platform_hold(uuid,text,text,text,text,text,integer,integer,integer,text,jsonb,text,text,integer,integer,text) to service_role;
grant execute on function public.credit_verified_platform_income_mirror(uuid,text,text,text,text,integer,integer,integer,text,jsonb,timestamptz) to service_role;
grant execute on function public.reserve_platform_hold_transfer(uuid,uuid,text,text,text) to service_role;
grant execute on function public.finish_platform_hold_transfer(uuid,uuid,text,text) to service_role;
grant execute on function public.read_platform_hold_owner_funds(uuid) to service_role;
grant execute on function public.platform_balance_move_from_sources(uuid,uuid,bigint,text,jsonb) to service_role;
grant execute on function public.reserve_platform_money_refund(uuid,text,integer,uuid,uuid,integer,text,boolean,boolean,jsonb) to service_role;
grant execute on function public.finish_platform_money_refund(text,text,integer) to service_role;
grant execute on function public.stamp_platform_pending_refund(text,text,text,integer) to service_role;
grant execute on function public.finish_platform_transfer_reversal(text,text,text,integer) to service_role;
grant execute on function public.finish_platform_refund_transfer_leg(text,text,text,integer,timestamptz) to service_role;
grant execute on function public.fail_platform_money_refund(text,text,text,text,integer) to service_role;
grant execute on function public.book_platform_refund_component(text,text,timestamptz) to service_role;
grant execute on function public.book_platform_refund_recovery_component(text,text,timestamptz) to service_role;
grant execute on function public.book_platform_refund_transfer_recovery_component(text,text,text) to service_role;
grant execute on function public.platform_refund_accounting_complete(uuid) to service_role;
grant execute on function public.reserve_platform_owner_recovery(uuid,uuid,uuid,text,integer,text) to service_role;
grant execute on function public.settle_platform_owner_recovery(text,text,text,text,timestamptz,timestamptz) to service_role;
grant execute on function public.credit_platform_income_with_recovery(uuid,text,text,text,text,integer,integer,integer,text,jsonb,timestamptz) to service_role;
