-- A FULL Stripe refund returns the GROSS the resident paid, which includes the processing fee they added at
-- checkout; the capture books that excess to `processing_recovery` and `credit_managed_capture` deliberately
-- allows gross > principal. `apply_managed_refund` refused anything above remaining principal, so a full refund
-- of such a payment was refused forever (409 on every webhook retry) and `owner_payable` was never debited.
-- The resident-added fee is now recorded per allocation and a refund may reverse principal PLUS that fee.
-- Additive: one defaulted column and create-or-replace.
alter table public.managed_rent_allocations
  add column if not exists refunded_added_cents integer not null default 0;

create or replace function public.apply_managed_refund(p_alloc uuid, p_refund text, p_amount bigint, p_posted timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a public.managed_rent_allocations%rowtype;
  v_key text; v_existing public.party_ledger_journals%rowtype;
  v_rp bigint; v_ra bigint; v_rf bigint; v_ro bigint; v_rb bigint; v_fee_total bigint;
  v_principal_part bigint; v_added_part bigint;
  v_fee_part bigint; v_borne_part bigint; v_owner_part bigint; v_deposit_part bigint := 0;
  v_lines jsonb; v_owner_party text; v_posted jsonb; v_status text;
begin
  select * into a from public.managed_rent_allocations where id = p_alloc for update;
  if not found then return jsonb_build_object('status', 'refused', 'reason', 'no_allocation'); end if;
  v_key := 'refund:' || p_refund || ':' || p_alloc::text;
  select * into v_existing from public.party_ledger_journals where idempotency_key = v_key;
  if found then return jsonb_build_object('status', 'exists', 'journal_id', v_existing.id); end if;

  v_rp := a.principal_cents - a.refunded_principal_cents;
  -- The resident-added processing fee still outstanding on this allocation (0 when the owner bore the fee).
  v_ra := greatest(coalesce(a.resident_added_cents, 0) - coalesce(a.refunded_added_cents, 0), 0);
  if p_amount <= 0 or p_amount > v_rp + v_ra then return jsonb_build_object('status', 'refused', 'reason', 'refund_exceeds_payment'); end if;
  -- Principal comes back first; only what is left over is the resident's processing fee being returned.
  v_principal_part := least(p_amount, v_rp);
  v_added_part := p_amount - v_principal_part;
  v_fee_total := a.fee_cents + a.leasing_cents;
  v_rf := v_fee_total - a.refunded_fee_cents;
  v_ro := a.owner_cents - a.refunded_owner_cents;
  v_rb := a.owner_borne_cents - a.refunded_borne_cents;
  if v_principal_part = 0 then
    v_fee_part := 0; v_borne_part := 0; v_owner_part := 0;
  elsif a.liability_class = 'deposit' then
    v_deposit_part := v_principal_part - (case when v_principal_part = v_rp then v_rb else ((v_rb * v_principal_part * 2 + v_rp) / (v_rp * 2)) end);
    v_borne_part := v_principal_part - v_deposit_part; v_fee_part := 0; v_owner_part := 0;
  elsif v_principal_part = v_rp then
    v_fee_part := v_rf; v_borne_part := v_rb; v_owner_part := v_ro;
  else
    v_fee_part := (v_rf * v_principal_part * 2 + v_rp) / (v_rp * 2);
    v_borne_part := (v_rb * v_principal_part * 2 + v_rp) / (v_rp * 2);
    v_owner_part := v_principal_part - v_fee_part - v_borne_part;
    if v_owner_part < 0 or v_owner_part > v_ro then return jsonb_build_object('status', 'refused', 'reason', 'owner_part_out_of_range'); end if;
  end if;
  if v_fee_part > v_rf or v_borne_part > v_rb then return jsonb_build_object('status', 'refused', 'reason', 'part_out_of_range'); end if;

  v_owner_party := 'owner:' || coalesce(a.owner_user_id::text, '');
  v_lines := jsonb_build_array(jsonb_build_object('account', 'platform_cash', 'amount_cents', -p_amount));
  -- The debit carries the credit's own availability, so a refund of money that has not matured yet nets against that pending credit.
  if v_owner_part > 0 then v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', 'owner_payable', 'party_id', v_owner_party, 'amount_cents', v_owner_part, 'available_on', a.available_on)); end if;
  if v_fee_part > 0 then v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', 'proplane_fee_revenue', 'amount_cents', v_fee_part)); end if;
  -- Both the owner-borne and the resident-added processing fee were credited to `processing_recovery` at capture.
  if v_borne_part + v_added_part > 0 then v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', 'processing_recovery', 'amount_cents', v_borne_part + v_added_part)); end if;
  if v_deposit_part > 0 then v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', 'tenant_deposit_liability', 'amount_cents', v_deposit_part)); end if;

  v_posted := public.post_party_journal(a.workspace_id, 'refund', v_key, 'stripe_refund', p_refund, a.stripe_charge_id,
    jsonb_build_object('allocation_id', p_alloc, 'charge_id', a.charge_id, 'amount_cents', p_amount, 'owner_cents', v_owner_part,
      'fee_cents', v_fee_part, 'borne_cents', v_borne_part, 'added_cents', v_added_part, 'deposit_cents', v_deposit_part,
      'property_id', a.property_id), v_lines, p_posted);

  v_status := case when a.refunded_principal_cents + v_principal_part >= a.principal_cents then 'refunded' else 'partially_refunded' end;
  update public.managed_rent_allocations set
    refunded_principal_cents = refunded_principal_cents + v_principal_part,
    refunded_fee_cents = refunded_fee_cents + v_fee_part,
    refunded_owner_cents = refunded_owner_cents + v_owner_part,
    refunded_borne_cents = refunded_borne_cents + v_borne_part,
    refunded_added_cents = coalesce(refunded_added_cents, 0) + v_added_part,
    status = case when status in ('disputed', 'dispute_lost') then status else v_status end,
    updated_at = now()
  where id = p_alloc;
  return jsonb_build_object('status', 'created', 'journal_id', v_posted->>'journal_id', 'owner_part', v_owner_part, 'fee_part', v_fee_part);
end;
$$;
