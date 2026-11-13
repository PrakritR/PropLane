-- Managed workspaces are the admin's workspaces (captain, Nov 12): "if it is managed by PropLane it is admin's workspace
-- with the client as property owner".
--
-- ONE mover, used three ways (the production one-shot, the dev rehearsal, and `attachWorkspaceToService` for every future
-- client): `move_managed_workspace_to_service_owner(workspace, expected_from, dry_run)`.
--   * `p_to` is never a parameter: it is read from `platform_service_settings` inside the function.
--   * One transaction, under the account-lifecycle advisory lock (723081447301) `demote_admin_team_role` takes.
--   * An ALLOWLIST: `managed_move_classification()` names every public table that carries a manager identity column as
--     MOVE (house/workspace scoped), ACCOUNT (no scope column; moves only when the client has no other live workspace),
--     KEEP (the client's own money/identity history; never written) or SPECIAL (written by a dedicated step). A table with
--     the identity column that is NOT listed and holds rows for the client STOPS the run, so a new table fails loud.
--   * `p_dry_run` computes the same counts with `select count(*)` and writes nothing; stops are reported, not raised.
--     A real run with any stop raises and writes nothing.
--   * Every moved row's primary key is recorded in `managed_workspace_ownership_moves` (the single-apply marker AND the
--     audit of who owned it before), so `undo_managed_workspace_move` restores exactly those rows inside a short window.
--   * `property_data` and `row_data` are never written (live-listing waiver: listing content untouched).
-- Additive and idempotent. service_role only; no client write grant; RLS on with no policy.

create table if not exists public.managed_workspace_ownership_moves (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  from_user_id uuid not null,
  to_user_id uuid not null,
  moved_at timestamptz not null default now(),
  undo_until timestamptz not null,
  undone_at timestamptz,
  counts jsonb not null default '{}'::jsonb,
  moved_rows jsonb not null default '{}'::jsonb,
  stash jsonb not null default '{}'::jsonb
);
create unique index if not exists managed_workspace_ownership_moves_live_uniq
  on public.managed_workspace_ownership_moves (workspace_id) where undone_at is null;
alter table public.managed_workspace_ownership_moves enable row level security;
revoke all on table public.managed_workspace_ownership_moves from public, anon, authenticated;
grant all on table public.managed_workspace_ownership_moves to service_role;

-- ------------------------------------------------------------ classification --
-- (table, klass, id_col). klass: move | account | keep | special. Keep this list in step with
-- tests/unit/managed-move-classification.test.ts, which reads this file and fails on any table with a manager identity
-- column that is missing here.
create or replace function public.managed_move_classification()
returns table (table_name text, klass text, id_col text)
language sql
immutable
set search_path = public
as $$
  select * from (values
    -- ---- SPECIAL: written by a dedicated step of the mover
    ('manager_property_records', 'special', 'manager_user_id'),
    ('manager_sms_numbers', 'special', 'manager_user_id'),
    ('manager_assistant_emails', 'special', 'manager_user_id'),
    ('manager_assistant_email_aliases', 'special', 'owner_user_id'),
    ('portal_workspaces', 'special', 'owner_user_id'),
    ('platform_service_settings', 'special', 'owner_user_id'),
    -- ---- MOVE: house- or workspace-scoped operational rows
    ('agent_sessions', 'move', 'landlord_id'),
    ('applicant_preapply_checks', 'move', 'manager_user_id'),
    ('application_fee_payment_claims', 'move', 'manager_user_id'),
    ('application_fee_waiver_redemptions', 'move', 'manager_user_id'),
    ('channel_finance_mail', 'move', 'manager_user_id'),
    ('channel_payout_records', 'move', 'manager_user_id'),
    ('external_calendar_connections', 'move', 'manager_user_id'),
    ('inbound_sms_log', 'move', 'manager_user_id'),
    ('lease_document_library', 'move', 'manager_user_id'),
    ('ledger_entries', 'move', 'manager_user_id'),
    ('listing_channel_connections', 'move', 'manager_user_id'),
    ('listing_channel_posts', 'move', 'manager_user_id'),
    ('manager_application_fee_waiver_codes', 'move', 'manager_user_id'),
    ('manager_application_records', 'move', 'manager_user_id'),
    ('manager_comms_workspace_wallets', 'move', 'manager_user_id'),
    ('manager_documents', 'move', 'manager_user_id'),
    ('manager_expense_entries', 'move', 'manager_user_id'),
    ('manager_expense_reversals', 'move', 'manager_user_id'),
    ('manager_house_public_links', 'move', 'manager_user_id'),
    ('manager_invite_links', 'move', 'owner_user_id'),
    ('manager_property_access', 'move', 'manager_user_id'),
    ('manager_property_owners', 'move', 'manager_user_id'),
    ('manager_sms_contacts', 'move', 'manager_user_id'),
    ('manager_sms_conversation_houses', 'move', 'manager_user_id'),
    ('manager_sms_messages', 'move', 'manager_user_id'),
    ('manager_syndication_feeds', 'move', 'manager_user_id'),
    ('manager_vendor_preferences', 'move', 'manager_user_id'),
    ('meta_messenger_replies', 'move', 'manager_user_id'),
    ('portal_household_charge_records', 'move', 'manager_user_id'),
    ('portal_inbox_thread_records', 'move', 'owner_user_id'),
    ('portal_lease_pipeline_records', 'move', 'manager_user_id'),
    ('portal_recurring_rent_profile_records', 'move', 'manager_user_id'),
    ('portal_schedule_records', 'move', 'manager_user_id'),
    ('portal_service_request_records', 'move', 'manager_user_id'),
    ('portal_work_order_records', 'move', 'manager_user_id'),
    ('property_utility_allocations', 'move', 'manager_user_id'),
    ('prospect_sms_tour_reminders', 'move', 'manager_user_id'),
    ('prospect_tour_scheduling_state', 'move', 'manager_user_id'),
    ('resident_evidence_policies', 'move', 'manager_user_id'),
    ('resident_evidence_submission_snapshots', 'move', 'manager_user_id'),
    ('resident_inspections', 'move', 'manager_user_id'),
    ('resident_invite_claims', 'move', 'owner_user_id'),
    ('resident_move_in_forms', 'move', 'manager_user_id'),
    ('resident_rent_reporting', 'move', 'manager_user_id'),
    ('resident_tour_links', 'move', 'manager_user_id'),
    ('sales_migration_records', 'move', 'manager_user_id'),
    ('security_deposit_ledger', 'move', 'manager_user_id'),
    ('sms_ai_reply_drafts', 'move', 'owner_user_id'),
    ('sms_entry_codes', 'move', 'owner_user_id'),
    ('sms_escalated_questions', 'move', 'owner_user_id'),
    ('sms_inbound_receipts', 'move', 'manager_user_id'),
    ('sms_outbox', 'move', 'manager_user_id'),
    ('sms_projection_conversations', 'move', 'owner_manager_user_id'),
    ('sms_projection_turns', 'move', 'owner_manager_user_id'),
    ('tour_signup_capabilities', 'move', 'manager_user_id'),
    ('tour_slot_reservations', 'move', 'manager_user_id'),
    ('vendor_dispatch_rules', 'move', 'owner_user_id'),
    ('vendor_dispatch_runs', 'move', 'owner_user_id'),
    ('vendor_marketplace_accounts', 'move', 'manager_user_id'),
    ('vendor_work_number_conversations', 'move', 'manager_user_id'),
    ('workspace_automation_runs', 'move', 'owner_user_id'),
    ('workspace_automation_settings', 'move', 'owner_user_id'),
    -- ---- ACCOUNT: no house or workspace column. Moves only when the client owns no other live workspace.
    ('action_events', 'account', 'manager_user_id'),
    ('application_adverse_actions', 'account', 'manager_user_id'),
    ('application_form_requests', 'account', 'manager_user_id'),
    ('claw_messaging_threads', 'account', 'manager_user_id'),
    ('cosigner_submission_records', 'account', 'manager_user_id'),
    ('document_share_links', 'account', 'manager_user_id'),
    ('google_calendar_pending_changes', 'account', 'owner_user_id'),
    ('household_charge_refund_attempts', 'account', 'manager_user_id'),
    ('manager_assistant_email_inbound', 'account', 'manager_user_id'),
    ('manager_document_templates', 'account', 'manager_user_id'),
    ('manager_late_fee_waivers', 'account', 'manager_user_id'),
    ('manager_payees', 'account', 'manager_user_id'),
    ('manager_portfolio_import_records', 'account', 'manager_user_id'),
    ('manager_portfolio_imports', 'account', 'manager_user_id'),
    ('manager_promotion_records', 'account', 'manager_user_id'),
    ('manager_vendor_records', 'account', 'manager_user_id'),
    ('portal_pro_relationship_records', 'account', 'manager_user_id'),
    ('portal_record_share_links', 'account', 'manager_user_id'),
    ('portal_reminder_records', 'account', 'manager_user_id'),
    ('portal_scheduled_inbox_message_records', 'account', 'manager_user_id'),
    ('payment_reminder_channel_coverage', 'account', 'manager_user_id'),
    ('payment_reminder_occurrences', 'account', 'manager_user_id'),
    ('scheduled_inbox_channel_deliveries', 'account', 'manager_user_id'),
    ('prospect_sms_bursts', 'account', 'manager_user_id'),
    ('prospect_sms_ingress', 'account', 'manager_user_id'),
    ('prospect_sms_inline_actions', 'account', 'manager_user_id'),
    ('prospect_sms_shadow_jobs', 'account', 'manager_user_id'),
    ('prospect_tour_bookings', 'account', 'manager_user_id'),
    ('prospect_tour_google_calendar_cleanup', 'account', 'manager_user_id'),
    ('prospect_tour_google_calendar_create_intents', 'account', 'manager_user_id'),
    ('resident_workspace_bindings', 'account', 'manager_user_id'),
    ('scheduled_message_overrides', 'account', 'manager_user_id'),
    ('screening_orders', 'account', 'manager_user_id'),
    ('service_share_links', 'account', 'manager_user_id'),
    ('service_workflow_steps', 'account', 'manager_user_id'),
    ('service_workflows', 'account', 'manager_user_id'),
    ('sms_control_receipts', 'account', 'manager_user_id'),
    ('sms_projection_aliases', 'account', 'owner_manager_user_id'),
    ('sms_projection_ambiguous_aliases', 'account', 'owner_manager_user_id'),
    ('sms_projection_deleted_events', 'account', 'owner_manager_user_id'),
    ('sms_projection_pending', 'account', 'owner_manager_user_id'),
    ('sms_provisioning_operations', 'account', 'manager_user_id'),
    ('sms_relay_messages', 'account', 'manager_user_id'),
    ('sms_relay_threads', 'account', 'manager_user_id'),
    ('sms_stay_offers', 'account', 'manager_user_id'),
    ('vendor_coordination_phone_bindings', 'account', 'manager_user_id'),
    ('vendor_coordination_phone_challenges', 'account', 'manager_user_id'),
    ('vendor_coordination_proposals', 'account', 'manager_user_id'),
    ('vendor_coordination_reservations', 'account', 'manager_user_id'),
    ('vendor_invites', 'account', 'manager_user_id'),
    ('vendor_invoices', 'account', 'manager_user_id'),
    ('vendor_outreach_workspace_profiles', 'account', 'manager_user_id'),
    ('vendor_quote_contact_capabilities', 'account', 'manager_user_id'),
    ('vendor_quote_email_outbox', 'account', 'manager_user_id'),
    ('vendor_quote_email_permissions', 'account', 'manager_user_id'),
    ('vendor_quote_sms_consent_challenges', 'account', 'manager_user_id'),
    ('vendor_quote_sms_consent_events', 'account', 'manager_user_id'),
    ('vendor_reviews', 'account', 'manager_user_id'),
    ('vendor_sourcing_candidates', 'account', 'manager_user_id'),
    ('vendor_sourcing_jobs', 'account', 'manager_user_id'),
    ('webhook_subscriptions', 'account', 'manager_user_id'),
    ('work_order_bids', 'account', 'manager_user_id'),
    ('work_order_open_listings', 'account', 'manager_user_id'),
    ('work_order_vendor_offers', 'account', 'manager_user_id'),
    ('workspace_work_number_recipients', 'account', 'owner_user_id'),
    -- ---- KEEP: the client's own money, identity and pre-management history. Asserted, never written.
    ('agent_messages', 'keep', 'landlord_id'),
    ('agent_pending_actions', 'keep', 'landlord_id'),
    ('audit_log', 'keep', 'landlord_id'),
    ('chart_of_accounts', 'keep', 'manager_user_id'),
    ('gl_journal_entries', 'keep', 'manager_user_id'),
    ('listing_prefill_usage', 'keep', 'manager_user_id'),
    ('managed_rent_allocations', 'keep', 'owner_user_id'),
    ('managed_workspace_fee_policies', 'keep', 'owner_user_id'),
    ('manager_automation_settings', 'keep', 'manager_user_id'),
    ('manager_bank_accounts', 'keep', 'manager_user_id'),
    ('manager_bank_statements', 'keep', 'manager_user_id'),
    ('manager_billing_settings', 'keep', 'manager_user_id'),
    ('manager_bills', 'keep', 'manager_user_id'),
    ('manager_budgets', 'keep', 'manager_user_id'),
    ('manager_comms_billing_accounts', 'keep', 'manager_user_id'),
    ('manager_comms_credit_adjustments', 'keep', 'manager_user_id'),
    ('manager_comms_credit_purchases', 'keep', 'manager_user_id'),
    ('manager_comms_usage_events', 'keep', 'manager_user_id'),
    ('manager_door_count_snapshots', 'keep', 'manager_user_id'),
    ('manager_owner_distributions', 'keep', 'manager_user_id'),
    ('manager_payment_plans', 'keep', 'manager_user_id'),
    ('manager_plan_addons', 'keep', 'manager_user_id'),
    ('manager_reclassification_log', 'keep', 'manager_user_id'),
    ('manager_reserve_policies', 'keep', 'manager_user_id'),
    ('manager_tax_profiles', 'keep', 'manager_user_id'),
    ('manager_tour_followup_controls', 'keep', 'manager_user_id'),
    ('number_credit_accounts', 'keep', 'owner_user_id'),
    ('number_credit_adjustments', 'keep', 'owner_user_id'),
    ('number_credit_purchases', 'keep', 'owner_user_id'),
    ('number_credit_usage_events', 'keep', 'owner_user_id'),
    ('number_subscriptions', 'keep', 'owner_user_id'),
    ('owner_expenses', 'keep', 'owner_user_id'),
    ('owner_statements', 'keep', 'owner_user_id'),
    ('payout_destination_cache_refreshes', 'keep', 'owner_user_id'),
    ('payout_destinations_cache', 'keep', 'owner_user_id'),
    ('payout_identity_status', 'keep', 'owner_user_id'),
    ('platform_hold_refund_attempts', 'keep', 'owner_user_id'),
    ('platform_hold_refund_transfer_legs', 'keep', 'owner_user_id'),
    ('platform_hold_transfer_attempts', 'keep', 'owner_user_id'),
    ('platform_payment_holds', 'keep', 'owner_user_id'),
    ('platform_revenue_entries', 'keep', 'manager_user_id'),
    ('platform_source_consumption_legs', 'keep', 'owner_user_id'),
    ('resident_checkout_attempts', 'keep', 'manager_user_id'),
    ('security_deposit_return_attempts', 'keep', 'manager_user_id'),
    ('sms_consent_events', 'keep', 'manager_user_id'),
    ('sms_delivery_log', 'keep', 'manager_user_id'),
    ('sms_manager_entitlements', 'keep', 'manager_user_id'),
    ('stripe_disputes', 'keep', 'manager_user_id'),
    ('stripe_payouts', 'keep', 'manager_user_id'),
    ('vendor_banking_disputes', 'keep', 'manager_user_id'),
    ('vendor_banking_ledger_entries', 'keep', 'manager_user_id'),
    ('vendor_dispatch_handle_counters', 'keep', 'owner_user_id'),
    ('vendor_payout_refunds', 'keep', 'manager_user_id'),
    ('vendor_payouts', 'keep', 'manager_user_id'),
    ('vendor_tax_profiles', 'keep', 'manager_user_id'),
    ('work_order_reference_counters', 'keep', 'manager_user_id')
  ) as t(table_name, klass, id_col);
$$;
revoke all on function public.managed_move_classification() from public, anon, authenticated;
grant execute on function public.managed_move_classification() to service_role;

-- Primary-key columns of a public table, in key order (empty when it has no primary key).
create or replace function public.managed_move_pk_columns(p_table text)
returns text[]
language sql
stable
set search_path = public
as $$
  select coalesce(array_agg(a.attname::text order by array_position(i.indkey::int2[], a.attnum)), '{}')
  from pg_index i
  join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
  where i.indrelid = to_regclass('public.' || quote_ident(p_table)) and i.indisprimary;
$$;
revoke all on function public.managed_move_pk_columns(text) from public, anon, authenticated;
grant execute on function public.managed_move_pk_columns(text) to service_role;

drop function if exists public.managed_move_scope_predicate(text, text);
-- The WHERE clause (params: $1 to, $2 from, $3 workspace, $4 house ids text[]) selecting a MOVE table's in-scope rows.
create or replace function public.managed_move_scope_predicate(p_table text, p_id_col text, p_residual boolean default false)
returns text
language plpgsql
stable
set search_path = public
as $$
declare
  v_parts text[] := '{}';
  v_nulls text[] := '{}';
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = p_table and column_name = 'property_id') then
    v_parts := array_append(v_parts, 'property_id::text = any($4)'::text);
    v_nulls := array_append(v_nulls, 'property_id is null'::text);
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = p_table and column_name = 'assigned_property_id') then
    v_parts := array_append(v_parts, 'assigned_property_id::text = any($4)'::text);
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = p_table and column_name = 'workspace_id') then
    v_parts := array_append(v_parts, 'workspace_id = $3'::text);
    v_nulls := array_append(v_nulls, 'workspace_id is null'::text);
  end if;
  -- A client with no other live workspace: a row that names neither a house nor a workspace is that account's only
  -- workspace's (sole-workspace rule), so it moves too. Rows naming another house or workspace never do.
  if p_residual and cardinality(v_nulls) > 0 then
    v_parts := array_append(v_parts, '(' || array_to_string(v_nulls, ' and ') || ')');
  end if;
  if cardinality(v_parts) = 0 then
    raise exception 'managed move classification error: % is MOVE but has no property_id, assigned_property_id or workspace_id', p_table using errcode = 'XX000';
  end if;
  return format('%I = $2 and (%s)', p_id_col, array_to_string(v_parts, ' or '));
end;
$$;
revoke all on function public.managed_move_scope_predicate(text, text, boolean) from public, anon, authenticated;
grant execute on function public.managed_move_scope_predicate(text, text, boolean) to service_role;

-- ------------------------------------------------------------------- mover --
create or replace function public.move_managed_workspace_to_service_owner(
  p_workspace uuid,
  p_expected_from uuid,
  p_dry_run boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ws public.portal_workspaces%rowtype;
  v_from uuid := p_expected_from;
  v_to uuid;
  v_house_ids text[];
  v_stops text[] := '{}';
  v_other_live integer;
  v_move jsonb := '{}'::jsonb;
  v_account jsonb := '{}'::jsonb;
  v_keep jsonb := '{}'::jsonb;
  v_left jsonb := '{}'::jsonb;
  v_moved_rows jsonb := '{}'::jsonb;
  v_prior public.managed_workspace_ownership_moves%rowtype;
  r record;
  v_pred text;
  v_pk text[];
  v_pk_list text;
  v_n bigint;
  v_total bigint;
  v_rows jsonb;
  v_seats_before jsonb;
  v_seat_deleted jsonb := '[]'::jsonb;
  v_seat_reinvited jsonb := '[]'::jsonb;
  v_seat_inserted uuid;
  v_client_seat_exists boolean;
  v_other_owner_of_record boolean;
  v_other_seat_for_client boolean;
  v_owner_perms jsonb := jsonb_build_object(
    'ownerPerformance', jsonb_build_object('read', true, 'notification', true),
    'ownerStatements', jsonb_build_object('read', true, 'notification', true),
    'ownerDocuments', jsonb_build_object('read', true, 'notification', true),
    'ownerMessages', jsonb_build_object('read', true, 'notification', true)
  );
  v_house_map jsonb;
  v_numbers jsonb := '[]'::jsonb;
  v_emails jsonb := '[]'::jsonb;
  v_aliases jsonb := '[]'::jsonb;
  v_holds jsonb := '[]'::jsonb;
  v_number_values text[];
  v_cleared_profile text;
  v_houses integer;
  v_open_checkouts integer;
  v_stale_pending integer;
  v_inflight_withdrawals integer;
  v_unclassified jsonb := '{}'::jsonb;
  v_table_count integer := 0;
begin
  if p_workspace is null or p_expected_from is null then
    raise exception 'Workspace and expected current owner are required.' using errcode = '22023';
  end if;

  select owner_user_id into v_to from public.platform_service_settings where singleton = true;
  if v_to is null then
    raise exception 'The PropLane service owner is not configured.' using errcode = 'P0002';
  end if;

  if not p_dry_run then
    perform pg_advisory_xact_lock(723081447301::bigint);
    select * into v_ws from public.portal_workspaces where id = p_workspace for update;
  else
    select * into v_ws from public.portal_workspaces where id = p_workspace;
  end if;
  if not found then
    raise exception 'Workspace not found.' using errcode = 'P0002';
  end if;

  -- Idempotent: a workspace already moved returns the stored counts and writes nothing.
  select * into v_prior from public.managed_workspace_ownership_moves where workspace_id = p_workspace and undone_at is null;
  if found and v_ws.owner_user_id = v_to then
    return jsonb_build_object('status', 'already_moved', 'workspace', p_workspace, 'from', v_prior.from_user_id, 'to', v_prior.to_user_id,
                              'movedAt', v_prior.moved_at, 'counts', v_prior.counts);
  end if;

  -- ---- guards (stops: reported on a dry run, raised before anything is written on a real one)
  if v_ws.is_service is distinct from true then v_stops := array_append(v_stops, ('workspace_not_service')::text); end if;
  if v_ws.owner_user_id is distinct from v_from then v_stops := array_append(v_stops, ('owner_is_not_expected_from')::text); end if;
  if v_from = v_to then v_stops := array_append(v_stops, ('from_equals_service_owner')::text); end if;
  if not exists (select 1 from public.profile_roles where user_id = v_to and role = 'admin') then
    v_stops := array_append(v_stops, ('service_owner_lacks_admin_role')::text);
  end if;
  if not exists (select 1 from public.profiles where id = v_from) then v_stops := array_append(v_stops, ('from_profile_missing')::text); end if;

  select coalesce(array_agg(id::text order by id), '{}') into v_house_ids from public.manager_property_records where workspace_id = p_workspace;
  v_houses := cardinality(v_house_ids);
  if exists (select 1 from public.manager_property_records where workspace_id = p_workspace and manager_user_id is distinct from v_from) then
    v_stops := array_append(v_stops, ('house_not_owned_by_expected_from')::text);
  end if;

  select count(*) into v_other_live from public.portal_workspaces
    where owner_user_id = v_from and id <> p_workspace and archived_at is null;

  -- open checkout attempts (money in flight under the old manager id) and reserved withdrawals stop the run
  select count(*) into v_open_checkouts from public.resident_checkout_attempts
    where manager_user_id = v_from and status in ('pending', 'processing') and created_at > now() - interval '24 hours';
  if v_open_checkouts > 0 then v_stops := array_append(v_stops, (('open_checkout_attempts:' || v_open_checkouts))::text); end if;
  select count(*) into v_stale_pending from public.resident_checkout_attempts
    where manager_user_id = v_from and status in ('pending', 'processing') and created_at <= now() - interval '24 hours';
  select count(*) into v_inflight_withdrawals from public.party_withdrawals
    where workspace_id = p_workspace and status in ('reserved', 'unknown');
  if v_inflight_withdrawals > 0 then v_stops := array_append(v_stops, (('pending_withdrawals:' || v_inflight_withdrawals))::text); end if;

  -- the client's seat: refuse when another owner of record, or a different-role seat of the client, is already there
  select exists (select 1 from public.account_link_invites where workspace_id = p_workspace and is_owner_of_record = true
                   and status in ('accepted', 'pending') and invitee_user_id is distinct from v_from) into v_other_owner_of_record;
  if v_other_owner_of_record then v_stops := array_append(v_stops, ('another_owner_of_record_seated')::text); end if;
  select exists (select 1 from public.account_link_invites where workspace_id = p_workspace and invitee_user_id = v_from
                   and status in ('accepted', 'pending') and team_role = 'property_owner') into v_client_seat_exists;
  select exists (select 1 from public.account_link_invites where workspace_id = p_workspace and invitee_user_id = v_from
                   and status in ('accepted', 'pending') and team_role is distinct from 'property_owner') into v_other_seat_for_client;
  if v_other_seat_for_client then v_stops := array_append(v_stops, ('client_holds_a_non_owner_seat')::text); end if;

  -- ---- unclassified tables: any manager-identity column not on the allowlist that holds rows for the client
  for r in
    select c.table_name::text as table_name, c.column_name::text as column_name
    from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
    where c.table_schema = 'public'
      and c.column_name in ('manager_user_id', 'owner_user_id', 'owner_manager_user_id', 'landlord_id')
      and not exists (select 1 from public.managed_move_classification() k where k.table_name = c.table_name)
  loop
    execute format('select count(*) from public.%I where %I = $1', r.table_name, r.column_name) into v_n using v_from;
    if v_n > 0 then
      v_unclassified := v_unclassified || jsonb_build_object(r.table_name, v_n);
      v_stops := array_append(v_stops, (('unclassified_table:' || r.table_name || ':' || v_n))::text);
    end if;
  end loop;

  -- ---- plan: counts for every MOVE / ACCOUNT / KEEP table
  for r in select * from public.managed_move_classification() where klass in ('move', 'account', 'keep') order by klass, table_name loop
    if to_regclass('public.' || quote_ident(r.table_name)) is null then continue; end if;
    v_table_count := v_table_count + 1;
    if r.klass = 'move' then
      v_pred := public.managed_move_scope_predicate(r.table_name, r.id_col, v_other_live = 0);
      execute format('select count(*) from public.%I where %s', r.table_name, v_pred) into v_n using v_to, v_from, p_workspace, v_house_ids;
      execute format('select count(*) from public.%I where %I = $2', r.table_name, r.id_col) into v_total using v_to, v_from;
      if v_n > 0 then v_move := v_move || jsonb_build_object(r.table_name, v_n); end if;
      if v_total - v_n > 0 then v_left := v_left || jsonb_build_object(r.table_name, v_total - v_n); end if;
    elsif r.klass = 'account' then
      execute format('select count(*) from public.%I where %I = $2', r.table_name, r.id_col) into v_n using v_to, v_from;
      if v_n > 0 then
        v_account := v_account || jsonb_build_object(r.table_name, v_n);
        if v_other_live > 0 then v_stops := array_append(v_stops, (('account_level_rows_with_another_live_workspace:' || r.table_name))::text); end if;
      end if;
    else
      execute format('select count(*) from public.%I where %I = $2', r.table_name, r.id_col) into v_n using v_to, v_from;
      if v_n > 0 then v_keep := v_keep || jsonb_build_object(r.table_name, v_n); end if;
    end if;
  end loop;

  if p_dry_run then
    return jsonb_build_object(
      'status', 'dry_run', 'workspace', p_workspace, 'workspaceName', v_ws.name, 'from', v_from, 'to', v_to,
      'houses', to_jsonb(v_house_ids), 'houseCount', v_houses, 'otherLiveWorkspacesOfClient', v_other_live,
      'move', v_move, 'account', v_account, 'keep', v_keep, 'leftBehind', v_left, 'unclassified', v_unclassified,
      'tablesScanned', v_table_count, 'openCheckouts', v_open_checkouts, 'stalePendingCheckouts', v_stale_pending,
      'pendingWithdrawals', v_inflight_withdrawals, 'clientSeatExists', v_client_seat_exists,
      'serviceOwnerOwnSeat', exists (select 1 from public.account_link_invites where workspace_id = p_workspace and inviter_user_id = v_from and invitee_user_id = v_to),
      'stops', to_jsonb(v_stops)
    );
  end if;

  if cardinality(v_stops) > 0 then
    raise exception 'managed move refused, nothing written: %', array_to_string(v_stops, '; ') using errcode = 'P0001';
  end if;

  -- ---- apply. Held off for this transaction only, exactly like the ownership-transfer RPC.
  perform set_config('app.workspace_ownership_transfer', 'on', true);

  select coalesce(jsonb_agg(to_jsonb(l)), '[]'::jsonb) into v_seats_before from public.account_link_invites l where l.workspace_id = p_workspace;

  update public.portal_workspaces set owner_user_id = v_to, is_default = false where id = p_workspace;
  update public.manager_property_records set manager_user_id = v_to, updated_at = now()
    where workspace_id = p_workspace and manager_user_id = v_from;

  for r in select * from public.managed_move_classification() where klass in ('move', 'account') order by klass, table_name loop
    if to_regclass('public.' || quote_ident(r.table_name)) is null then continue; end if;
    v_pk := public.managed_move_pk_columns(r.table_name);
    if cardinality(v_pk) = 0 then
      raise exception 'managed move classification error: % has no primary key, so its move could not be undone', r.table_name using errcode = 'XX000';
    end if;
    select string_agg(format('%I', c), ', ') into v_pk_list from unnest(v_pk) as c;
    if r.klass = 'move' then
      v_pred := public.managed_move_scope_predicate(r.table_name, r.id_col, v_other_live = 0);
    else
      v_pred := format('%I = $2', r.id_col);
    end if;
    execute format('with m as (update public.%I set %I = $1 where %s returning %s) select count(*), coalesce(jsonb_agg(to_jsonb(m)), ''[]''::jsonb) from m',
                   r.table_name, r.id_col, v_pred, v_pk_list)
      into v_n, v_rows using v_to, v_from, p_workspace, v_house_ids;
    if v_n > 0 then v_moved_rows := v_moved_rows || jsonb_build_object(r.table_name, jsonb_build_object('idCol', r.id_col, 'pk', to_jsonb(v_pk), 'rows', v_rows)); end if;
  end loop;

  -- memberships: the service owner's own seat goes (they own it now); every other live seat answers to the service owner;
  -- the client is seated as the Property owner of record (view-only: the four owner keys, no module key).
  with d as (delete from public.account_link_invites where workspace_id = p_workspace and inviter_user_id = v_from and invitee_user_id = v_to returning id)
    select coalesce(jsonb_agg(id), '[]'::jsonb) into v_seat_deleted from d;
  with u as (update public.account_link_invites set inviter_user_id = v_to
               where workspace_id = p_workspace and inviter_user_id = v_from and status in ('pending', 'accepted') returning id)
    select coalesce(jsonb_agg(id), '[]'::jsonb) into v_seat_reinvited from u;
  select coalesce(jsonb_object_agg(h, v_owner_perms), '{}'::jsonb) into v_house_map from unnest(v_house_ids) as h;
  if v_client_seat_exists then
    update public.account_link_invites set is_owner_of_record = true, is_service_seat = false
      where workspace_id = p_workspace and invitee_user_id = v_from and team_role = 'property_owner' and status in ('accepted', 'pending')
        and not exists (select 1 from public.account_link_invites o where o.workspace_id = p_workspace and o.is_owner_of_record = true and o.invitee_user_id <> v_from and o.status in ('accepted', 'pending'));
  else
    insert into public.account_link_invites (
      inviter_user_id, invitee_user_id, tab_kind, inviter_axis_id, invitee_axis_id, inviter_display_name, invitee_display_name,
      assigned_property_ids, payout_percent_for_manager, property_co_manager_permissions, co_manager_permissions,
      workspace_id, workspace_permissions, team_role, house_scope, invited_via, invited_at, responded_at, status,
      is_owner_of_record, is_service_seat
    )
    select v_to, v_from, 'manager', coalesce(pt.manager_id, ''), coalesce(pf.manager_id, ''),
           coalesce(pt.full_name, pt.email, 'PropLane'), coalesce(pf.full_name, pf.email, 'Owner'),
           to_jsonb(v_house_ids), 0, v_house_map, v_owner_perms,
           p_workspace, '{}'::jsonb, 'property_owner', 'selected', 'code', now(), now(), 'accepted', true, false
    from public.profiles pt, public.profiles pf where pt.id = v_to and pf.id = v_from
    returning id into v_seat_inserted;
  end if;

  -- work identity (as the ownership-transfer RPC does): numbers and emails follow the workspace; holds that would now cross
  -- owners are dropped; the client's cached default line is cleared when it just left them.
  with n as (update public.manager_sms_numbers set manager_user_id = v_to, updated_at = now()
               where workspace_id = p_workspace and manager_user_id = v_from returning id, phone_number)
    select coalesce(jsonb_agg(id), '[]'::jsonb), coalesce(array_agg(phone_number) filter (where phone_number is not null), '{}')
      into v_numbers, v_number_values from n;
  with e as (update public.manager_assistant_emails set manager_user_id = v_to
               where workspace_id = p_workspace and manager_user_id = v_from returning id)
    select coalesce(jsonb_agg(id), '[]'::jsonb) into v_emails from e;
  with a as (update public.manager_assistant_email_aliases set owner_user_id = v_to
               where owner_user_id = v_from and assistant_email_id in (select jsonb_array_elements_text(v_emails)::uuid) returning mailbox_local)
    select coalesce(jsonb_agg(mailbox_local), '[]'::jsonb) into v_aliases from a;
  with h as (delete from public.workspace_work_numbers h using public.manager_sms_numbers n
               where h.number_id = n.id and h.workspace_id = p_workspace and n.manager_user_id <> v_to returning h.*)
    select coalesce(jsonb_agg(to_jsonb(h)), '[]'::jsonb) into v_holds from h;
  with h2 as (delete from public.workspace_work_numbers h using public.manager_sms_numbers n, public.portal_workspaces w
               where h.number_id = n.id and w.id = h.workspace_id and n.workspace_id = p_workspace
                 and w.owner_user_id = v_from and h.workspace_id <> p_workspace returning h.*)
    select v_holds || coalesce(jsonb_agg(to_jsonb(h2)), '[]'::jsonb) into v_holds from h2;
  if array_length(v_number_values, 1) is not null then
    select sms_from_number into v_cleared_profile from public.profiles where id = v_from and sms_from_number = any (v_number_values);
    if v_cleared_profile is not null then
      update public.profiles set sms_from_number = null, updated_at = now() where id = v_from and sms_from_number = v_cleared_profile;
    end if;
  end if;

  insert into public.managed_workspace_ownership_moves (workspace_id, from_user_id, to_user_id, undo_until, counts, moved_rows, stash)
  values (
    p_workspace, v_from, v_to, now() + interval '2 hours',
    jsonb_build_object('houses', v_houses, 'move', v_move, 'account', v_account, 'keep', v_keep, 'leftBehind', v_left),
    v_moved_rows,
    jsonb_build_object(
      'wasDefault', v_ws.is_default, 'seatsBefore', v_seats_before, 'seatsDeleted', v_seat_deleted, 'seatsReinvited', v_seat_reinvited,
      'seatInserted', v_seat_inserted, 'clientSeatExisted', v_client_seat_exists, 'numbers', v_numbers, 'emails', v_emails,
      'aliases', v_aliases, 'holds', v_holds, 'clearedProfileLine', v_cleared_profile, 'houseIds', to_jsonb(v_house_ids)
    )
  );

  perform set_config('app.workspace_ownership_transfer', 'off', true);

  return jsonb_build_object('status', 'moved', 'workspace', p_workspace, 'from', v_from, 'to', v_to, 'houses', v_houses,
                            'move', v_move, 'account', v_account, 'keep', v_keep, 'leftBehind', v_left, 'seatInserted', v_seat_inserted);
end;
$$;
revoke all on function public.move_managed_workspace_to_service_owner(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.move_managed_workspace_to_service_owner(uuid, uuid, boolean) to service_role;

-- -------------------------------------------------------------------- undo --
-- Valid only inside the read-back window (`undo_until`) and only once: restores exactly the rows the move recorded.
-- After new activity lands it is not a clean restore (design R7): forward-fix instead.
create or replace function public.undo_managed_workspace_move(p_workspace uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_move public.managed_workspace_ownership_moves%rowtype;
  r record;
  v_pk text[];
  v_pk_join text;
  v_restored bigint := 0;
  v_n bigint;
  v_stash jsonb;
begin
  perform pg_advisory_xact_lock(723081447301::bigint);
  select * into v_move from public.managed_workspace_ownership_moves where workspace_id = p_workspace and undone_at is null for update;
  if not found then
    raise exception 'No live ownership move to undo for this workspace.' using errcode = 'P0002';
  end if;
  if now() > v_move.undo_until then
    raise exception 'The undo window for this move has closed; forward-fix instead.' using errcode = 'P0001';
  end if;
  v_stash := v_move.stash;
  perform set_config('app.workspace_ownership_transfer', 'on', true);

  update public.portal_workspaces set owner_user_id = v_move.from_user_id, is_default = coalesce((v_stash ->> 'wasDefault')::boolean, false)
    where id = p_workspace and owner_user_id = v_move.to_user_id;
  update public.manager_property_records set manager_user_id = v_move.from_user_id, updated_at = now()
    where workspace_id = p_workspace and manager_user_id = v_move.to_user_id;

  for r in select key as table_name, value as spec from jsonb_each(v_move.moved_rows) loop
    select array_agg(x) into v_pk from jsonb_array_elements_text(r.spec -> 'pk') as x;
    select string_agg(format('t.%1$I = k.%1$I', c), ' and ') into v_pk_join from unnest(v_pk) as c;
    execute format(
      'update public.%1$I t set %2$I = $1 from jsonb_populate_recordset(null::public.%1$I, $2) k where %3$s and t.%2$I = $3',
      r.table_name, r.spec ->> 'idCol', v_pk_join
    ) using v_move.from_user_id, r.spec -> 'rows', v_move.to_user_id;
    get diagnostics v_n = row_count;
    v_restored := v_restored + v_n;
  end loop;

  -- seats
  if (v_stash ->> 'seatInserted') is not null then
    delete from public.account_link_invites where id = (v_stash ->> 'seatInserted')::uuid;
  elsif (v_stash ->> 'clientSeatExisted')::boolean is true then
    null; -- the client's own seat existed and was only re-pointed; restored below with the others
  end if;
  update public.account_link_invites set inviter_user_id = v_move.from_user_id
    where id in (select (jsonb_array_elements_text(v_stash -> 'seatsReinvited'))::uuid);
  insert into public.account_link_invites
    select (jsonb_populate_record(null::public.account_link_invites, s)).*
    from jsonb_array_elements(v_stash -> 'seatsBefore') as s
    where (s ->> 'id')::uuid in (select (jsonb_array_elements_text(v_stash -> 'seatsDeleted'))::uuid)
    on conflict (id) do nothing;
  if (v_stash ->> 'clientSeatExisted')::boolean is true then
    update public.account_link_invites l set is_owner_of_record = (s ->> 'is_owner_of_record')::boolean, is_service_seat = (s ->> 'is_service_seat')::boolean
      from jsonb_array_elements(v_stash -> 'seatsBefore') as s where l.id = (s ->> 'id')::uuid;
  end if;

  -- work identity
  update public.manager_sms_numbers set manager_user_id = v_move.from_user_id, updated_at = now()
    where id in (select (jsonb_array_elements_text(v_stash -> 'numbers'))::uuid) and manager_user_id = v_move.to_user_id;
  update public.manager_assistant_emails set manager_user_id = v_move.from_user_id
    where id in (select (jsonb_array_elements_text(v_stash -> 'emails'))::uuid) and manager_user_id = v_move.to_user_id;
  update public.manager_assistant_email_aliases set owner_user_id = v_move.from_user_id
    where mailbox_local in (select jsonb_array_elements_text(v_stash -> 'aliases')) and owner_user_id = v_move.to_user_id;
  insert into public.workspace_work_numbers
    select (jsonb_populate_record(null::public.workspace_work_numbers, h)).* from jsonb_array_elements(v_stash -> 'holds') as h
    on conflict do nothing;
  if (v_stash ->> 'clearedProfileLine') is not null then
    update public.profiles set sms_from_number = v_stash ->> 'clearedProfileLine', updated_at = now()
      where id = v_move.from_user_id and sms_from_number is null;
  end if;

  update public.managed_workspace_ownership_moves set undone_at = now() where id = v_move.id;
  perform set_config('app.workspace_ownership_transfer', 'off', true);
  return jsonb_build_object('status', 'undone', 'workspace', p_workspace, 'restoredRows', v_restored);
end;
$$;
revoke all on function public.undo_managed_workspace_move(uuid) from public, anon, authenticated;
grant execute on function public.undo_managed_workspace_move(uuid) to service_role;
