/**
 * Pure pieces of `scripts/delete-account.mjs`, split out so the parts that decide WHAT gets
 * deleted can be tested without a database. The dangerous half — actually issuing the deletes —
 * stays in the script behind its target guard.
 */

/** `https://abcdefgh.supabase.co` → `abcdefgh`; a local stack → its `host:port`. */
export function targetFromUrl(rawUrl) {
  let host;
  try {
    host = new URL(rawUrl).host;
  } catch {
    return "";
  }
  const hosted = /^([a-z0-9-]+)\.supabase\.(co|in|red)$/i.exec(host);
  return hosted ? hosted[1] : host;
}

/**
 * The columns a row can be owned by.
 *
 * Scoping is NOT just `manager_user_id`. Rows also hang off `resident_email` — a STRING, not an
 * id — and off several other id columns. Missing one leaves orphaned rows with no owner, which
 * is exactly how ghost data survives a "clean" reset.
 */
export const ID_COLUMNS = [
  "manager_user_id",
  "resident_user_id",
  "vendor_user_id",
  "owner_user_id",
  "landlord_id",
  "user_id",
  // Columns that name the account on somebody else's row. This script exists to leave a QA
  // environment with no trace of the address, so it removes those rows too; the in-app purge
  // (src/lib/auth/account-purge-manifest.ts) detaches them instead, because there the other
  // party's business record has to survive.
  "inviter_user_id",
  "invitee_user_id",
  "related_user_id",
  "actor_user_id",
  "recipient_user_id",
  "sender_user_id",
  "counterparty_user_id",
  "matched_sender_user_id",
  "accepted_user_id",
  "redeemed_by_user_id",
  "reporter_user_id",
];

export const EMAIL_COLUMNS = [
  "resident_email",
  "participant_email",
  "vendor_email",
  "email",
  "recipient_email",
  "attendee_email",
  "reporter_email",
  "related_email",
  "contact_email",
  "owner_email",
  "sender_email",
];

/**
 * Delete order, coarsest dependency first — the same phases as the in-app purge manifest
 * (`src/lib/auth/account-purge-manifest.ts`), which `tests/unit/account-deletion-plan.test.ts`
 * keeps in step so a table added to one cannot go missing from the other.
 *
 * Foreign keys reject the obvious order, and the failures are opaque mid-transaction errors
 * rather than anything naming the real problem, so the order is recorded here instead of being
 * rediscovered each time:
 *
 *   - the GL chain first, or deleting the user fails on `ledger_entries_gl_journal_entry_id_fkey`
 *   - the whole vendor chain before `portal_work_order_records`
 *   - `manager_property_records` last, because most things reference a property
 */
export const DELETE_ORDER = [
  // 1. child rows, and the GL/vendor chains that must clear first
  "gl_journal_lines",
  "ledger_entries",
  "security_deposit_ledger",
  "manager_reclassification_log",
  "manager_owner_distributions",
  "manager_late_fee_waivers",
  "manager_payment_plans",
  "manager_bank_statement_lines",
  "manager_invite_link_redemptions",
  "application_fee_waiver_redemptions",
  "document_share_links",
  "portal_record_share_links",
  "cosigner_submission_records",
  "screening_orders",
  "work_order_bids",
  "work_order_vendor_offers",
  "work_order_reference_counters",
  "vendor_invoices",
  "vendor_payouts",
  "vendor_tax_profiles",
  "vendor_availability_rules",
  "vendor_invites",
  "action_event_deliveries",
  "agent_messages",
  "agent_pending_actions",
  "sms_relay_bindings",
  "sms_relay_messages",
  "sms_delivery_log",
  "sms_inbound_receipts",
  "sms_control_receipts",
  "sms_consent_events",
  "sms_provisioning_operations",
  "inbound_sms_log",
  "manager_assistant_email_inbound",
  // 2. the account's own rows
  "manager_property_access",
  "manager_property_owners",
  "manager_application_records",
  "manager_application_fee_waiver_codes",
  "manager_automation_settings",
  "manager_billing_settings",
  "manager_bank_accounts",
  "manager_budgets",
  "manager_comms_billing_accounts",
  "manager_comms_usage_events",
  "manager_document_templates",
  "manager_promotion_records",
  "manager_reserve_policies",
  "manager_tax_profiles",
  "manager_api_keys",
  "manager_assistant_emails",
  "manager_sms_numbers",
  "manager_sms_contacts",
  "manager_sms_messages",
  "manager_purchases",
  "chart_of_accounts",
  "stripe_disputes",
  "stripe_payouts",
  "external_calendar_connections",
  "account_link_invites",
  "portal_pro_relationship_records",
  "portal_household_charge_records",
  "portal_recurring_rent_profile_records",
  "portal_lease_pipeline_records",
  "portal_resident_lease_upload_records",
  "portal_service_request_records",
  "portal_schedule_records",
  "portal_scheduled_inbox_message_records",
  "portal_reminder_records",
  "portal_outbound_mail_records",
  "portal_bug_feedback_records",
  "claw_messaging_threads",
  "resident_tour_links",
  "scheduled_message_overrides",
  "notification_preferences",
  "agent_user_preferences",
  "device_push_tokens",
  "phone_verifications",
  "sms_consent",
  "sms_manager_entitlements",
  "sms_outbox",
  "mcp_oauth_authorization_codes",
  "mcp_oauth_tokens",
  "resident_inspections",
  "resident_housemate_sharing",
  "manager_expense_entries",
  "audit_log",
  // 3. foreign-key parents: journals, work orders, documents, properties
  "gl_journal_entries",
  "manager_bills",
  "manager_bank_statements",
  "manager_invite_links",
  "manager_documents",
  "agent_sessions",
  "action_events",
  "sms_relay_threads",
  "manager_vendor_records",
  "portal_work_order_records",
  "portal_inbox_thread_records",
  "manager_property_records",
];

/** Tables holding the login itself, removed only when the caller is not keeping it. */
export const IDENTITY_TABLES = ["profile_roles", "profiles"];

/**
 * A PostgREST `or=(…)` filter matching every row this account owns in one table.
 *
 * Email columns match on the address and id columns on the user id, so a table keyed only on
 * `resident_email` is still cleaned for an account whose auth user was already removed.
 * Returns null when the table has no scoping column we recognise — the caller must then SKIP
 * it rather than delete unfiltered.
 */
export function ownershipFilter(columns, { userId, email }) {
  const clauses = [];
  for (const col of columns) {
    if (EMAIL_COLUMNS.includes(col)) {
      if (email) clauses.push(`${col}.eq.${email}`);
    } else if (ID_COLUMNS.includes(col) && userId) {
      clauses.push(`${col}.eq.${userId}`);
    }
  }
  return clauses.length ? `or=(${clauses.join(",")})` : null;
}
