/**
 * Every `public` table an account purge has to reason about, and which columns tie a row
 * to a manager, resident, or vendor account.
 *
 * Why a manifest instead of a hand-written list of deletes: the old purge named ~30 tables
 * inline, the schema has 100+, and the gap was invisible. Rows survived a "permanent" delete
 * (bank accounts, budgets, expenses, API keys, SMS logs, calendar links, invite links, tour
 * links, agent chat history…), so re-registering the same email landed on an account that
 * still remembered the last one. `tests/unit/account-purge-coverage.test.ts` reads
 * `supabase/migrations/*.sql` and fails when a table — or an ownership column on it — is
 * neither listed here nor explicitly retained below, so a new table cannot silently reopen
 * the gap.
 *
 * `ids` match the account's auth user id, `emails` the account's normalized (lowercased)
 * email. `detachIds` / `detachEmails` null the column out instead of deleting the row: the
 * row is somebody else's business record that merely references this account (a manager's
 * vendor directory entry, an audit trail's actor).
 */

import { ADMIN_INBOX_SCOPE } from "@/lib/portal-inbox-thread-scope";

export type PurgeScope = "manager" | "resident" | "vendor";

export type PurgeScopeRule = {
  ids?: readonly string[];
  emails?: readonly string[];
  detachIds?: readonly string[];
  detachEmails?: readonly string[];
  /** Extra guard applied to every statement for this scope (see the inbox rule below). */
  restrict?: { column: string; notEquals: string };
};

export type PurgeTableRule = {
  table: string;
  /**
   * Phase 1 runs first, then 2, then 3. Every inter-table foreign key in this schema is
   * `on delete cascade` or `on delete set null`, so phases are about not firing a child
   * delete concurrently with the cascade that is already removing it — children first,
   * parents (journal entries, work orders, properties, documents) last.
   */
  phase: 1 | 2 | 3;
  manager?: PurgeScopeRule;
  resident?: PurgeScopeRule;
  vendor?: PurgeScopeRule;
};

export const ACCOUNT_PURGE_TABLES: readonly PurgeTableRule[] = [
  // ---------------------------------------------------------------- phase 1: child rows
  {
    table: "gl_journal_lines",
    phase: 1,
    // The manager's general ledger lines go with their journal entries (cascade); a resident
    // is only a reference on them, so the manager keeps the books.
    resident: { detachIds: ["resident_user_id"] },
  },
  {
    table: "ledger_entries",
    phase: 1,
    manager: { ids: ["manager_user_id"] },
    resident: { ids: ["resident_user_id"], emails: ["resident_email"] },
  },
  {
    table: "security_deposit_ledger",
    phase: 1,
    manager: { ids: ["manager_user_id"] },
    resident: { ids: ["resident_user_id"], emails: ["resident_email"] },
  },
  {
    table: "manager_reclassification_log",
    phase: 1,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "manager_owner_distributions",
    phase: 1,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "manager_late_fee_waivers",
    phase: 1,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "manager_payment_plans",
    phase: 1,
    manager: { ids: ["manager_user_id"] },
    resident: { ids: ["resident_user_id"], emails: ["resident_email"] },
  },
  {
    table: "manager_bank_statement_lines",
    phase: 1,
    // No ownership column; cascades from manager_bank_statements.
  },
  {
    table: "manager_invite_link_redemptions",
    phase: 1,
    manager: { ids: ["redeemed_by_user_id"] },
    resident: { ids: ["redeemed_by_user_id"] },
    vendor: { ids: ["redeemed_by_user_id"] },
  },
  {
    table: "application_fee_waiver_redemptions",
    phase: 1,
    manager: { ids: ["manager_user_id"] },
    resident: { emails: ["resident_email"] },
  },
  {
    table: "document_share_links",
    phase: 1,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "portal_record_share_links",
    phase: 1,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "cosigner_submission_records",
    phase: 1,
    manager: { ids: ["manager_user_id"] },
    // Resident rows are keyed by application id — resolved by the resident purge.
  },
  {
    table: "screening_orders",
    phase: 1,
    manager: { ids: ["manager_user_id"] },
    // Resident rows are keyed by application id — resolved by the resident purge.
  },
  {
    table: "work_order_bids",
    phase: 1,
    manager: { ids: ["manager_user_id"] },
    vendor: { ids: ["vendor_user_id"] },
  },
  {
    table: "work_order_vendor_offers",
    phase: 1,
    manager: { ids: ["manager_user_id"] },
    vendor: { ids: ["vendor_user_id"] },
  },
  {
    table: "work_order_reference_counters",
    phase: 1,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "vendor_invoices",
    phase: 1,
    manager: { ids: ["manager_user_id"] },
    vendor: { ids: ["vendor_user_id"] },
  },
  {
    table: "vendor_payouts",
    phase: 1,
    manager: { ids: ["manager_user_id"] },
    vendor: { ids: ["vendor_user_id"] },
  },
  {
    table: "vendor_tax_profiles",
    phase: 1,
    manager: { ids: ["manager_user_id"] },
    vendor: { ids: ["vendor_user_id"] },
  },
  {
    table: "vendor_availability_rules",
    phase: 1,
    vendor: { ids: ["vendor_user_id"] },
  },
  {
    table: "vendor_invites",
    phase: 1,
    manager: { ids: ["manager_user_id"] },
    vendor: { emails: ["vendor_email"], detachIds: ["accepted_user_id"] },
  },
  {
    table: "action_event_deliveries",
    phase: 1,
    manager: { ids: ["recipient_user_id"] },
    resident: { ids: ["recipient_user_id"], emails: ["recipient_email"] },
    vendor: { ids: ["recipient_user_id"], emails: ["recipient_email"] },
  },
  {
    table: "agent_messages",
    phase: 1,
    manager: { ids: ["landlord_id"] },
    resident: { ids: ["landlord_id"] },
    vendor: { ids: ["landlord_id"] },
  },
  {
    table: "agent_pending_actions",
    phase: 1,
    manager: { ids: ["landlord_id", "user_id"] },
    resident: { ids: ["user_id"] },
    vendor: { ids: ["user_id"] },
  },
  {
    table: "sms_relay_bindings",
    phase: 1,
    manager: { ids: ["user_id"] },
    resident: { ids: ["user_id"] },
    vendor: { ids: ["user_id"] },
  },
  {
    table: "sms_relay_messages",
    phase: 1,
    manager: { ids: ["manager_user_id"] },
    resident: { ids: ["sender_user_id"] },
    vendor: { ids: ["sender_user_id"] },
  },
  {
    table: "sms_delivery_log",
    phase: 1,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "sms_inbound_receipts",
    phase: 1,
    manager: { ids: ["manager_user_id"] },
    resident: { detachIds: ["counterparty_user_id"] },
    vendor: { detachIds: ["counterparty_user_id"] },
  },
  {
    table: "sms_control_receipts",
    phase: 1,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "sms_consent_events",
    phase: 1,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "sms_provisioning_operations",
    phase: 1,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "inbound_sms_log",
    phase: 1,
    manager: { ids: ["manager_user_id"] },
    resident: { detachIds: ["matched_sender_user_id"] },
    vendor: { detachIds: ["matched_sender_user_id"] },
  },
  {
    table: "property_utility_allocations",
    phase: 1,
    // `bill_id` is a plain FK onto manager_bills (phase 3) and `manager_user_id` a plain FK
    // onto auth.users, so these rows have to clear before either parent goes.
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "manager_assistant_email_inbound",
    phase: 1,
    manager: { ids: ["manager_user_id"] },
  },

  // ------------------------------------------------------------- phase 2: the account rows
  {
    table: "manager_property_access",
    phase: 2,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "manager_property_owners",
    phase: 2,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "manager_application_records",
    phase: 2,
    manager: { ids: ["manager_user_id"] },
    resident: { emails: ["resident_email"] },
  },
  {
    table: "manager_application_fee_waiver_codes",
    phase: 2,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "manager_automation_settings",
    phase: 2,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "manager_billing_settings",
    phase: 2,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "manager_bank_accounts",
    phase: 2,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "manager_budgets",
    phase: 2,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "manager_comms_billing_accounts",
    phase: 2,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "manager_comms_usage_events",
    phase: 2,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "manager_document_templates",
    phase: 2,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "manager_promotion_records",
    phase: 2,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "manager_reserve_policies",
    phase: 2,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "manager_tax_profiles",
    phase: 2,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "manager_api_keys",
    phase: 2,
    manager: { ids: ["user_id"] },
  },
  {
    table: "manager_assistant_emails",
    phase: 2,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "manager_sms_numbers",
    phase: 2,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "manager_sms_contacts",
    phase: 2,
    manager: { ids: ["manager_user_id"] },
    resident: { emails: ["contact_email"] },
    vendor: { emails: ["contact_email"] },
  },
  {
    table: "manager_sms_messages",
    phase: 2,
    manager: { ids: ["manager_user_id"] },
    resident: { ids: ["resident_user_id"] },
  },
  {
    table: "manager_purchases",
    phase: 2,
    // The email match is the load-bearing half: `user_id` is `on delete set null`, so a
    // purchase row survives auth deletion holding the email that would be reused.
    manager: { ids: ["user_id"], emails: ["email"] },
  },
  {
    table: "chart_of_accounts",
    phase: 2,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "stripe_disputes",
    phase: 2,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "stripe_payouts",
    phase: 2,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "external_calendar_connections",
    phase: 2,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "account_link_invites",
    phase: 2,
    manager: { ids: ["inviter_user_id", "invitee_user_id"] },
  },
  {
    table: "portal_pro_relationship_records",
    phase: 2,
    manager: { ids: ["manager_user_id", "related_user_id"] },
    resident: { ids: ["related_user_id"], emails: ["related_email"] },
    vendor: { ids: ["related_user_id"], emails: ["related_email"] },
  },
  {
    table: "portal_household_charge_records",
    phase: 2,
    manager: { ids: ["manager_user_id"] },
    resident: { ids: ["resident_user_id"], emails: ["resident_email"] },
  },
  {
    table: "portal_recurring_rent_profile_records",
    phase: 2,
    manager: { ids: ["manager_user_id"] },
    resident: { ids: ["resident_user_id"], emails: ["resident_email"] },
  },
  {
    table: "portal_lease_pipeline_records",
    phase: 2,
    manager: { ids: ["manager_user_id"] },
    resident: { ids: ["resident_user_id"], emails: ["resident_email"] },
  },
  {
    table: "portal_resident_lease_upload_records",
    phase: 2,
    resident: { ids: ["resident_user_id"], emails: ["resident_email"] },
  },
  {
    table: "portal_service_request_records",
    phase: 2,
    manager: { ids: ["manager_user_id"] },
    resident: { emails: ["resident_email"] },
  },
  {
    table: "portal_schedule_records",
    phase: 2,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "portal_scheduled_inbox_message_records",
    phase: 2,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "portal_reminder_records",
    phase: 2,
    manager: { ids: ["manager_user_id"] },
    resident: { emails: ["recipient_email"] },
    vendor: { emails: ["recipient_email"] },
  },
  {
    table: "portal_outbound_mail_records",
    phase: 2,
    manager: { emails: ["recipient_email"] },
    resident: { emails: ["recipient_email"] },
    vendor: { emails: ["recipient_email"] },
  },
  {
    table: "portal_bug_feedback_records",
    phase: 2,
    manager: { ids: ["reporter_user_id"], emails: ["reporter_email"] },
    resident: { ids: ["reporter_user_id"], emails: ["reporter_email"] },
    vendor: { ids: ["reporter_user_id"], emails: ["reporter_email"] },
  },
  {
    table: "claw_messaging_threads",
    phase: 2,
    manager: { ids: ["manager_user_id"] },
    resident: { ids: ["resident_user_id"], emails: ["resident_email"] },
  },
  {
    table: "resident_tour_links",
    phase: 2,
    manager: { ids: ["manager_user_id"] },
    resident: { ids: ["resident_user_id"], emails: ["attendee_email"] },
  },
  {
    table: "scheduled_message_overrides",
    phase: 2,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "notification_preferences",
    phase: 2,
    manager: { ids: ["user_id"] },
    resident: { ids: ["user_id"] },
    vendor: { ids: ["user_id"] },
  },
  {
    table: "agent_user_preferences",
    phase: 2,
    manager: { ids: ["user_id"] },
    resident: { ids: ["user_id"] },
    vendor: { ids: ["user_id"] },
  },
  {
    table: "device_push_tokens",
    phase: 2,
    manager: { ids: ["user_id"] },
    resident: { ids: ["user_id"] },
    vendor: { ids: ["user_id"] },
  },
  {
    table: "phone_verifications",
    phase: 2,
    manager: { ids: ["user_id"] },
    resident: { ids: ["user_id"] },
    vendor: { ids: ["user_id"] },
  },
  {
    table: "sms_consent",
    phase: 2,
    manager: { ids: ["user_id"] },
    resident: { ids: ["user_id"] },
    vendor: { ids: ["user_id"] },
  },
  {
    table: "sms_manager_entitlements",
    phase: 2,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "sms_outbox",
    phase: 2,
    manager: { ids: ["manager_user_id", "actor_user_id"] },
    resident: { ids: ["recipient_user_id"], emails: ["recipient_email"] },
    vendor: { ids: ["recipient_user_id"], emails: ["recipient_email"] },
  },
  {
    table: "mcp_oauth_authorization_codes",
    phase: 2,
    manager: { ids: ["user_id"] },
    resident: { ids: ["user_id"] },
    vendor: { ids: ["user_id"] },
  },
  {
    table: "mcp_oauth_tokens",
    phase: 2,
    manager: { ids: ["user_id"] },
    resident: { ids: ["user_id"] },
    vendor: { ids: ["user_id"] },
  },
  {
    table: "sales_migration_records",
    phase: 2,
    // Plain FK onto auth.users, same as resident_inspections: clear before the login goes.
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "resident_inspections",
    phase: 2,
    // `manager_user_id` is a plain FK with no delete action, so these rows must go before the
    // auth user does or `deleteProfileAndAuthUser` fails on the constraint.
    manager: { ids: ["manager_user_id"] },
    resident: { ids: ["resident_user_id"], emails: ["resident_email"] },
  },
  {
    table: "resident_housemate_sharing",
    phase: 2,
    manager: { ids: ["user_id"] },
    resident: { ids: ["user_id"] },
    vendor: { ids: ["user_id"] },
  },
  {
    table: "manager_expense_entries",
    phase: 2,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "audit_log",
    phase: 2,
    // The manager's own audit trail goes with the account; on every other scope the row is
    // somebody else's trail and only the actor pointer is cleared.
    manager: { ids: ["landlord_id"], detachIds: ["actor_user_id"] },
    resident: { detachIds: ["actor_user_id"] },
    vendor: { detachIds: ["actor_user_id"] },
  },

  // ------------------------------------------------------- phase 3: FK parents, last
  {
    table: "gl_journal_entries",
    phase: 3,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "manager_bills",
    phase: 3,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "manager_bank_statements",
    phase: 3,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "manager_invite_links",
    phase: 3,
    manager: { ids: ["owner_user_id"] },
  },
  {
    table: "manager_documents",
    phase: 3,
    manager: { ids: ["manager_user_id"] },
    // A manager-uploaded file stays the manager's record; only the resident pointer clears.
    resident: { detachIds: ["resident_user_id"], detachEmails: ["resident_email"] },
  },
  {
    table: "agent_sessions",
    phase: 3,
    manager: { ids: ["landlord_id", "user_id"] },
    resident: { ids: ["user_id"] },
    vendor: { ids: ["user_id", "vendor_user_id"] },
  },
  {
    table: "action_events",
    phase: 3,
    manager: { ids: ["manager_user_id"] },
    // The event stays the manager's; only the sender identity copied onto it clears.
    resident: { detachIds: ["sender_user_id"], detachEmails: ["sender_email"] },
    vendor: { detachIds: ["sender_user_id"], detachEmails: ["sender_email"] },
  },
  {
    table: "sms_relay_threads",
    phase: 3,
    manager: { ids: ["manager_user_id"] },
    resident: { ids: ["counterparty_user_id"] },
    vendor: { ids: ["counterparty_user_id"] },
  },
  {
    table: "manager_vendor_records",
    phase: 3,
    manager: { ids: ["manager_user_id"] },
    vendor: { detachIds: ["vendor_user_id"] },
  },
  {
    table: "portal_work_order_records",
    phase: 3,
    manager: { ids: ["manager_user_id"] },
    resident: { emails: ["resident_email"] },
    // Dispatch history belongs to the manager; only the vendor pointer clears.
    vendor: { detachIds: ["vendor_user_id"] },
  },
  {
    table: "portal_inbox_thread_records",
    // The shared `admin` support inbox is never collateral of a personal account delete —
    // an admin who also manages properties would otherwise take support@ down with them.
      phase: 3,
    manager: {
      ids: ["owner_user_id"],
      restrict: { column: "scope", notEquals: ADMIN_INBOX_SCOPE },
    },
    resident: {
      ids: ["owner_user_id"],
      emails: ["participant_email"],
      restrict: { column: "scope", notEquals: ADMIN_INBOX_SCOPE },
    },
    vendor: {
      ids: ["owner_user_id"],
      emails: ["participant_email"],
      restrict: { column: "scope", notEquals: ADMIN_INBOX_SCOPE },
    },
  },
  {
    table: "manager_property_records",
    phase: 3,
    manager: { ids: ["manager_user_id"] },
  },
];

/**
 * Tables no account purge touches, each with the reason. The coverage guard treats an
 * entry here as a decision; an unlisted table is a gap.
 */
export const ACCOUNT_PURGE_RETAINED: Readonly<Record<string, string>> = {
  profiles: "Identity row — deleted by the auth-user cascade in deleteProfileAndAuthUser.",
  profile_roles: "Identity row — deleted by the auth-user cascade in deleteProfileAndAuthUser.",
  mcp_oauth_clients: "Shared OAuth client registry, not owned by any one account.",
  site_config_records: "Global site configuration.",
  site_content_records: "Global marketing/site content.",
  site_preset_records: "Global site presets.",
  sms_relay_numbers: "Shared relay number pool — released by closeRelayThreadsForUser, never deleted.",
  sms_runtime_config: "Global SMS runtime configuration.",
  sms_delivery_attempts: "Child of sms_outbox (cascades); carries no account column.",
  sms_delivery_events: "Child of sms_outbox (cascades); carries no account column.",
  sms_provider_events: "Raw provider webhook log; carries no account column.",
  sms_segment_usage: "Aggregate billing counters; carries no account column.",
  rate_limit_buckets: "Hashed request counters keyed by bucket, with no account column and a short reset window.",
  application_document_storage_aliases:
    "Child of manager_application_records (cascades); keyed on the storage path, not an account.",
};

/**
 * `table.column` pairs the coverage guard should not treat as an account key, each with the
 * reason. Contact copies and foreign keys onto other tables live here; an account key never
 * does.
 */
export const NON_OWNERSHIP_COLUMNS: Readonly<Record<string, string>> = {
  "manager_property_owners.owner_email": "Contact address for a third-party property owner, not a PropLane login.",
  "manager_sms_contacts.contact_email": "Denormalized contact address on the manager's own SMS contact row.",
};

export function purgeRulesForScope(scope: PurgeScope, phase: 1 | 2 | 3) {
  return ACCOUNT_PURGE_TABLES.filter((rule) => rule.phase === phase && rule[scope]);
}
