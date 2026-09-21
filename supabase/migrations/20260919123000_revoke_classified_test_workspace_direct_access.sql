-- A durable test identity must never use the public authenticated PostgREST or
-- Storage surface as a customer account. This intentionally does not inspect
-- the feature flag: PostgreSQL cannot see server environment configuration,
-- and suspension/expiry/flag-off must not reclassify the identity.
--
-- The server routes use service-role clients and re-authorize private access.
-- Only `profiles`, `profile_roles`, test-workspace membership, and public site
-- configuration remain outside this list for identity/classification recovery.

create or replace function public.is_classified_test_workspace_principal()
returns boolean
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select exists(
    select 1
    from public.test_workspace_members member
    where member.user_id = auth.uid()
  );
$$;

revoke all on function public.is_classified_test_workspace_principal() from public, anon;
grant execute on function public.is_classified_test_workspace_principal() to authenticated;

do $$
declare
  table_name text;
begin
  -- Exact DEV direct-access catalog, excluding only self identity, durable
  -- test classification, and the three public site-configuration tables.
  foreach table_name in array array[
    'scheduled_message_overrides', 'vendor_invoices', 'portal_inbox_thread_records',
    'manager_purchases', 'manager_documents', 'document_share_links',
    'manager_property_records', 'portal_schedule_records', 'portal_resident_lease_upload_records',
    'portal_outbound_mail_records', 'manager_application_records', 'portal_work_order_records',
    'portal_lease_pipeline_records', 'portal_pro_relationship_records', 'gl_journal_entries',
    'audit_log', 'screening_orders', 'manager_vendor_records', 'chart_of_accounts',
    'gl_journal_lines', 'cosigner_submission_records', 'manager_tax_profiles',
    'device_push_tokens', 'portal_bug_feedback_records', 'portal_scheduled_inbox_message_records',
    'work_order_bids', 'vendor_tax_profiles', 'ledger_entries', 'manager_promotion_records',
    'vendor_invites', 'manager_expense_entries', 'vendor_payouts', 'stripe_payouts',
    'stripe_disputes', 'phone_verifications', 'security_deposit_ledger',
    'manager_bank_accounts', 'manager_reclassification_log', 'sms_consent',
    'manager_bank_statement_lines', 'sms_relay_numbers', 'sms_relay_bindings',
    'sms_relay_threads', 'sms_relay_messages', 'sms_delivery_log', 'inbound_sms_log',
    'manager_budgets', 'manager_property_owners', 'manager_reserve_policies',
    'manager_owner_distributions', 'agent_messages', 'notification_preferences',
    'claw_messaging_threads', 'manager_sms_messages', 'manager_bills',
    'manager_billing_settings', 'manager_payment_plans', 'manager_late_fee_waivers',
    'agent_pending_actions', 'manager_property_access', 'manager_document_templates',
    'work_order_vendor_offers', 'vendor_availability_rules',
    'application_fee_waiver_redemptions', 'manager_api_keys',
    'manager_application_fee_waiver_codes', 'external_calendar_connections',
    'mcp_oauth_clients', 'mcp_oauth_authorization_codes', 'mcp_oauth_tokens',
    'resident_tour_links', 'manager_sms_numbers', 'sms_runtime_config',
    'sms_manager_entitlements', 'sms_delivery_attempts', 'sms_outbox',
    'sms_provisioning_operations', 'sms_consent_events', 'manager_sms_contacts',
    'sms_provider_events', 'sms_delivery_events', 'sms_segment_usage',
    'sms_control_receipts', 'portal_record_share_links', 'manager_assistant_email_inbound',
    'manager_comms_billing_accounts', 'portal_reminder_records', 'manager_invite_links',
    'rate_limit_buckets', 'manager_invite_link_redemptions',
    'application_document_storage_aliases', 'action_events', 'resident_housemate_sharing',
    'property_utility_allocations', 'manager_bank_statements', 'sales_migration_records',
    'account_link_invites', 'work_order_reference_counters', 'resident_invite_claims',
    'resident_inspections', 'portal_recurring_rent_profile_records',
    'manager_automation_settings', 'portal_service_request_records', 'sms_inbound_receipts',
    'vendor_business_profiles', 'manager_comms_usage_events', 'comms_credit_policy',
    'manager_comms_credit_purchases', 'manager_comms_credit_adjustments',
    'manager_sms_conversation_houses', 'portal_workspaces', 'manager_plan_addons',
    'manager_house_public_links', 'manager_tour_followup_controls',
    'prospect_sms_inline_actions', 'prospect_sms_shadow_jobs', 'listing_prefill_cache',
    'listing_prefill_usage', 'manager_portfolio_import_records', 'manager_portfolio_imports',
    'tour_slot_reservations', 'prospect_sms_tour_reminders', 'manager_assistant_emails',
    'tour_inquiry_claims', 'prospect_tour_google_calendar_cleanup',
    'prospect_tour_google_calendar_create_intents', 'prospect_sms_ingress',
    'action_event_deliveries', 'agent_sessions', 'portal_household_charge_records',
    'prospect_sms_bursts', 'prospect_tour_scheduling_state', 'prospect_tour_bookings',
    'test_workspace_schedule_records', 'account_deleted_record_identities',
    'account_recovery_records', 'account_recovery_holds', 'account_recovery_dependencies',
    'account_recovery_requests', 'account_deleted_storage_keys',
    'account_recovery_retired_source_keys', 'account_recovery_objects',
    'account_recovery_object_holds', 'account_recovery_object_records',
    'account_recovery_retired_objects', 'account_deleted_identity_keys'
  ]
  loop
    if to_regclass(format('public.%I', table_name)) is null then
      raise exception 'Required test-workspace direct-access table is missing: %', table_name;
    end if;
    execute format('alter table public.%I enable row level security', table_name);
    execute format('drop policy if exists test_workspace_classified_direct_deny on public.%I', table_name);
    execute format(
      'create policy test_workspace_classified_direct_deny on public.%I as restrictive for all to authenticated using (not (select public.is_classified_test_workspace_principal())) with check (not (select public.is_classified_test_workspace_principal()))',
      table_name
    );
  end loop;
end;
$$;

-- RLS does not constrain SECURITY DEFINER routines. The reviewed DEV catalog
-- identified allocate_sms_proxy_number(uuid) as the one business definer
-- executable by browser roles. It allocates a globally shared relay number and
-- has no safe direct-client contract, so close its exact signature while
-- retaining the service-role relay route. Do not use a catalog-wide revoke:
-- policy helpers can also be SECURITY DEFINER, and revoking their caller
-- privilege would break ordinary RLS reads.
revoke all on function public.allocate_sms_proxy_number(uuid) from public, anon, authenticated;
grant execute on function public.allocate_sms_proxy_number(uuid) to service_role;

-- The same reviewed inventory preserves current_user_has_password() for own
-- account recovery and current_test_workspace_membership() for own durable
-- classification. The remaining exposed definers are trigger functions, not
-- browser RPCs. A future browser-callable business RPC must either refuse
-- classified principals in its body or be explicitly revoked from browser
-- roles with its exact signature.

-- Storage policies are bucket-specific permissive policies. A restrictive
-- policy on storage.objects blocks every direct authenticated object operation
-- for classified accounts, including listing media uploads. Server-minted
-- routes retain control of any necessary private test flow.
drop policy if exists test_workspace_classified_direct_storage_deny on storage.objects;
create policy test_workspace_classified_direct_storage_deny
  on storage.objects
  as restrictive
  for all
  to authenticated
  using (not public.is_classified_test_workspace_principal())
  with check (not public.is_classified_test_workspace_principal());
