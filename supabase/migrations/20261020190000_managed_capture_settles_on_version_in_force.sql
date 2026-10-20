-- ---------------------------------------------------------------------------------------------
-- credit_managed_capture: a payment settles on the fee version that was in force the day it was taken.
--
-- An ACH debit is days old by the time `payment_intent.succeeded` arrives, and an admin's rate change in
-- Admin > Service activates a new version TODAY and ends the previous one. The application resolver
-- (`loadActivePolicyForWorkspace`) answers a dated read with the version whose [effective_from, ends_on) window
-- covers that day - which is an ENDED row once it has been replaced - so that a payment in flight keeps the split
-- it was taken under instead of reading as "not managed" and falling through to a manager hold.
--
-- This function refused every non-active version, so that capture would 409 forever. It now accepts an ended
-- version, and ONLY for rows whose own `paid_at` falls inside that version's window. Every other guard - the
-- workspace match, the signature, the month-totals conflict check, the per-row leasing cap, the monthly fee bound
-- and the balanced journal - is unchanged.
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
  if not found or v_pol.workspace_id is distinct from p_workspace or v_pol.signed_at is null
     or v_pol.status not in ('active', 'ended') then
    return jsonb_build_object('status', 'refused', 'reason', 'policy_not_active');
  end if;
  -- An ENDED version may still take a payment that was made while it was in force: the window it covers is
  -- [effective_from, ends_on), the same one the application resolver reads, in Pacific days.
  if v_pol.status = 'ended' then
    if v_pol.ends_on is null then
      return jsonb_build_object('status', 'refused', 'reason', 'policy_not_active');
    end if;
    if exists (
      select 1 from jsonb_array_elements(p_rows) r
      where ((coalesce((r->>'paid_at')::timestamptz, now()) at time zone 'America/Los_Angeles')::date < v_pol.effective_from
          or (coalesce((r->>'paid_at')::timestamptz, now()) at time zone 'America/Los_Angeles')::date >= v_pol.ends_on)
    ) then
      return jsonb_build_object('status', 'refused', 'reason', 'policy_not_active');
    end if;
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

revoke all on function public.credit_managed_capture(uuid, uuid, text, text, text, text, timestamptz, bigint, bigint, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.credit_managed_capture(uuid, uuid, text, text, text, text, timestamptz, bigint, bigint, bigint, jsonb) to service_role;
