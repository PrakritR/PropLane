-- A reused withdrawal idempotency key must answer with what was STORED, never with what the new request says.
-- reserve_party_withdrawal's `exists` result now carries the stored amount, party, destination, status and age so the caller
-- can refuse a mismatch (409) and carry out only the stored reservation. Replaces the function body only; behaviour for new keys,
-- in-flight, insufficient and reserved results is unchanged. Idempotent.
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
    return jsonb_build_object(
      'status', 'exists', 'withdrawal_id', v_existing.id, 'withdrawal_status', v_existing.status,
      'amount_cents', v_existing.amount_cents, 'party_id', v_existing.party_id, 'party_kind', v_existing.party_kind,
      'workspace_id', v_existing.workspace_id, 'destination_account_id', v_existing.destination_account_id,
      'stripe_transfer_id', v_existing.stripe_transfer_id, 'stripe_payout_id', v_existing.stripe_payout_id,
      'created_at', v_existing.created_at);
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

revoke all on function public.reserve_party_withdrawal(text, text, uuid, bigint, text, text, bigint, text) from public, anon, authenticated;
grant execute on function public.reserve_party_withdrawal(text, text, uuid, bigint, text, text, bigint, text) to service_role;
