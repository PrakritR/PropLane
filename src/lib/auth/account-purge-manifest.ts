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
  /** Keep the surviving owner's books and sever every resident access key. */
  preserveFinancial?: boolean;
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
  phase: 1 | 2 | 3 | 4;
  manager?: PurgeScopeRule;
  resident?: PurgeScopeRule;
  vendor?: PurgeScopeRule;
};

export const ACCOUNT_PURGE_TABLES: readonly PurgeTableRule[] = [
  {
    table: "portal_workspaces",
    // Properties must be removed first; deleting a workspace never deletes houses.
    phase: 4,
    manager: { ids: ["owner_user_id"] },
  },
  // ---------------------------------------------------------------- phase 1: child rows
  {
    // Source receipts are private conversation content and cascade from the
    // durable burst. Keep this explicit so the account-purge coverage test
    // cannot silently leave a re-registered manager's prospect history.
    table: "prospect_sms_ingress",
    phase: 1,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "prospect_tour_bookings",
    phase: 1,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "prospect_tour_google_calendar_cleanup",
    phase: 1,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "prospect_tour_google_calendar_create_intents",
    phase: 1,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "tour_slot_reservations",
    phase: 1,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "prospect_tour_scheduling_state",
    phase: 1,
    manager: { ids: ["manager_user_id"] },
    resident: { emails: ["contact_email"] },
    vendor: { emails: ["contact_email"] },
  },
  {
    table: "prospect_sms_inline_actions",
    phase: 1,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "prospect_sms_shadow_jobs",
    phase: 1,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "prospect_sms_tour_reminders",
    phase: 1,
    manager: { ids: ["manager_user_id"] },
  },
  {
    // Per-door billing snapshot (docs/agents/plan-entitlements.md); billing
    // history for a purged account, same as any other usage snapshot.
    table: "manager_door_count_snapshots",
    phase: 1,
    manager: { ids: ["manager_user_id"] },
  },
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
    resident: { ids: ["resident_user_id"], emails: ["resident_email"], preserveFinancial: true },
  },
  {
    table: "security_deposit_ledger",
    phase: 1,
    manager: { ids: ["manager_user_id"] },
    resident: { ids: ["resident_user_id"], emails: ["resident_email"], preserveFinancial: true },
  },
  {
    table: "resident_autopay_settings",
    phase: 1,
    manager: { ids: ["manager_id"] },
    resident: { ids: ["resident_user_id"] },
  },
  {
    table: "resident_autopay_runs",
    phase: 1,
    manager: { ids: ["manager_id"] },
    resident: { ids: ["resident_user_id"] },
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
    resident: { ids: ["resident_user_id"], emails: ["resident_email"], preserveFinancial: true },
  },
  {
    table: "resident_rent_reporting",
    phase: 1,
    manager: { ids: ["manager_user_id"] },
    resident: { ids: ["resident_user_id"] },
  },
  {
    table: "rent_reporting_submissions",
    phase: 1,
    // No manager_user_id column; cascades from resident_rent_reporting when the
    // manager is purged. Resident is classified directly since the column exists.
    resident: { ids: ["resident_user_id"] },
  },
  {
    table: "manager_bank_statement_lines",
    phase: 1,
    // No ownership column; cascades from manager_bank_statements.
  },
  {
    table: "webhook_deliveries",
    phase: 1,
    // No ownership column: the attempt journal cascades from webhook_subscriptions,
    // which is deleted with the manager below.
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
    table: "manager_house_public_links",
    phase: 1,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "manager_syndication_feeds",
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
    manager: { ids: ["manager_user_id"], preserveFinancial: true },
    vendor: { ids: ["vendor_user_id"], preserveFinancial: true },
  },
  {
    table: "vendor_payouts",
    phase: 1,
    manager: { ids: ["manager_user_id"], preserveFinancial: true },
    vendor: { ids: ["vendor_user_id"], preserveFinancial: true },
  },
  {
    table: "platform_payment_holds",
    phase: 1,
    manager: { ids: ["owner_user_id"], preserveFinancial: true },
    vendor: { ids: ["owner_user_id"], preserveFinancial: true },
  },
  {
    // night/vendor-pay, PROPLANE_BALANCE_ENABLED. `owner_key` holds the
    // manager id for owner_kind='workspace' and the vendor id for
    // owner_kind='vendor' — see the migration header for why "workspace"
    // resolves onto the manager identity, not portal_workspaces.id.
    table: "proplane_balance_accounts",
    phase: 1,
    manager: { ids: ["owner_key"], preserveFinancial: true },
    vendor: { ids: ["owner_key"], preserveFinancial: true },
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
    // Workspace rung of the settings scope (PLAN-0920-0845); owned by the workspace owner.
    table: "workspace_automation_settings",
    phase: 2,
    manager: { ids: ["owner_user_id"] },
  },
  {
    // Address-prefill lookups this manager spent each month (docs/agents/listing-prefill.md).
    table: "listing_prefill_usage",
    phase: 1,
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
  { table: "manager_comms_credit_adjustments", phase: 2, manager: { ids: ["manager_user_id"] } },
  { table: "manager_plan_addons", phase: 2, manager: { ids: ["manager_user_id"] } },
  { table: "manager_comms_credit_purchases", phase: 2, manager: { ids: ["manager_user_id"] } },
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
    table: "manager_comms_workspace_wallets",
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
    // The endpoint AND its encrypted signing secret go with the account; the
    // delivery journal cascades from here.
    table: "webhook_subscriptions",
    phase: 2,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "manager_assistant_emails",
    phase: 2,
    manager: { ids: ["manager_user_id"] },
  },
  {
    // A renamed work email held as an alias for 30 days; cascades from the email row too.
    table: "manager_assistant_email_aliases",
    phase: 2,
    manager: { ids: ["owner_user_id"] },
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
    // Which house(s) a Communication thread is about. Owned by the workspace's
    // manager; the co-manager who tagged it is recorded, not an owner.
    table: "manager_sms_conversation_houses",
    phase: 2,
    manager: { ids: ["manager_user_id", "tagged_by_user_id"] },
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
    // Display-only Connect identity-verification status cache
    // (PLAN-0920-1500 Part C). `owner_user_id` is whichever role's profile
    // holds the Connect account — a manager's own or a vendor's own, never
    // both for the same row — so both scopes key off the same column.
    table: "payout_identity_status",
    phase: 2,
    manager: { ids: ["owner_user_id"] },
    vendor: { ids: ["owner_user_id"] },
  },
  {
    table: "stripe_payouts",
    phase: 2,
    manager: { ids: ["manager_user_id"] },
    // Set only for a vendor-initiated in-app payout (PLAN-0920-0853); a
    // manager row leaves this null.
    vendor: { ids: ["vendor_user_id"] },
  },
  {
    // Display cache of a Connect account's bank accounts / debit cards
    // (PLAN-0920-1500 part B). `owner_user_id` is generic — a manager's own
    // id for a manager account, a vendor's own id for a vendor account, the
    // same pattern `profiles.stripe_connect_account_id` already uses — so it
    // is classified under both scopes; a given row only ever matches one.
    table: "payout_destinations_cache",
    phase: 2,
    manager: { ids: ["owner_user_id"] },
    vendor: { ids: ["owner_user_id"] },
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
    resident: { ids: ["resident_user_id"], emails: ["resident_email"], preserveFinancial: true },
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
    resident: { ids: ["resident_user_id"], emails: ["resident_email"], preserveFinancial: true },
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
    table: "scheduled_inbox_channel_deliveries",
    phase: 1,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "portal_scheduled_inbox_message_records",
    phase: 2,
    manager: { ids: ["manager_user_id"] },
    // Recipient is only in row_data — resident purge deletes via JSON filters in
    // purgeResidentPortalData (no promoted recipient_email column on this table).
  },
  {
    table: "manager_tour_followup_controls",
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
    table: "payment_reminder_occurrences",
    phase: 2,
    manager: { ids: ["manager_user_id"] },
    resident: { emails: ["recipient_email"] },
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
    table: "prospect_sms_bursts",
    phase: 2,
    manager: { ids: ["manager_user_id"] },
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
    // Portfolio import drafts (spreadsheet / AppFolio / Buildium / rent-roll pdf) and
    // their per-record receipts: owner-scoped, cascade off auth.users, PII inside `draft`.
    table: "manager_portfolio_import_records",
    phase: 2,
    manager: { ids: ["manager_user_id"] },
  },
  {
    table: "manager_portfolio_imports",
    phase: 2,
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
    // Phase 2: a claim references `manager_invite_links`, so it goes before the
    // link it hangs off (phase 3) rather than tripping the FK.
    //
    // Both sides DELETE the row. A claim is one person saying "I live at this
    // manager's property" — with either party gone there is nobody to approve
    // it and nobody it could be approved onto, so detaching a pointer would
    // leave an unresolvable request holding the other person's email.
    table: "resident_invite_claims",
    phase: 2,
    manager: { ids: ["owner_user_id"] },
    resident: { ids: ["claimant_user_id"], emails: ["claimant_email"] },
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
    // The vendor's own business record — theirs alone, gone with the login.
    table: "vendor_business_profiles",
    phase: 3,
    vendor: { ids: ["user_id"] },
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
  {
    table: "vendor_work_identities",
    phase: 3,
    vendor: { ids: ["vendor_user_id"] },
  },
];

/**
 * Tables no account purge touches, each with the reason. The coverage guard treats an
 * entry here as a decision; an unlisted table is a gap.
 */
export const ACCOUNT_PURGE_RETAINED: Readonly<Record<string, string>> = {
  vendor_work_identity_runtime: "Global sponsored-identity runtime limits; it contains no account data.",
  vendor_work_identity_operations: "Child of vendor_work_identities; removed by identity cascade after release is queued.",
  vendor_work_identity_outbox: "Child of vendor_work_identities; removed by identity cascade after release is queued.",
  vendor_work_identity_delivery_attempts: "Child of vendor_work_identity_outbox; removed by outbox cascade.",
  vendor_work_identity_usage_events: "Child of vendor_work_identities; removed by identity cascade and never used for billing.",
  vendor_work_identity_reply_bindings: "Child of vendor_work_identities; service-role reply authorization facts are removed by identity cascade after release is queued.",
  vendor_work_identity_release_queue: "Retained provider-release work with copied external IDs; it must survive account deletion until reconciled.",
  listing_prefill_cache: "Provider answers keyed by normalized street address; holds no account data.",
  payment_reminder_channel_deliveries: "Child of payment_reminder_occurrences; deleted by cascade.",
  payment_reminder_channel_coverage: "Child of payment_reminder_occurrences; deleted by cascade.",
  comms_credit_policy: "Global credit-policy cutover timestamp; contains no account data.",
  account_recovery_retired_source_keys: "Hashes of obsolete physical file paths; stop delayed uploads after logical recovery.",
  account_recovery_objects: "Private retained file generations and active logical-path mappings; lifecycle-managed.",
  account_recovery_object_holds: "Shared file retention ownership; lifecycle-managed.",
  account_recovery_object_records: "Shared file-to-record references; lifecycle-managed.",
  account_recovery_retired_objects: "Opaque obsolete file keys for retryable garbage collection; no user identity or original filename.",
  account_recovery_requests: "Private 30-day deletion lifecycle; finalized by the recovery worker, not the live-data purge.",
  account_recovery_records: "Shared private retained generations; per-request holds govern recovery and permanent erasure.",
  account_recovery_holds: "Per-request ownership and conditional identity patches; removed by lifecycle finalization.",
  account_recovery_dependencies: "Deletion-only dependency graph for retained generations; no incidental identity references.",
  account_deleted_storage_keys: "Non-recoverable hashes of retired immutable Storage keys; stop late uploads from recreating erased files.",
  account_deleted_identity_keys: "Non-recoverable per-column access hashes; explicit recovery removes only the selected identity keys.",
  account_deleted_record_identities: "Non-recoverable hashed identity guards for retained business history; survive ordinary row deletion to block stale delete/reinsert.",
  profiles: "Identity row — deleted by the auth-user cascade in deleteProfileAndAuthUser.",
  profile_roles: "Identity row — deleted by the auth-user cascade in deleteProfileAndAuthUser.",
  test_workspace_members:
    "Durable test-domain classification by opaque auth UUID; retained so deleted or suspended accounts cannot fall through into customer behavior.",
  test_workspaces:
    "Durable test-domain namespace and audit owner; retained because member and record provenance must remain classifiable after account deletion.",
  test_workspace_schedule_records:
    "Shared test-workspace schedule state; retained with its durable workspace namespace so classified activity cannot fall through into customer scheduling.",
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
  tour_inquiry_claims:
    "Short-lived confirm mutex keyed by inquiry id; the row is deleted when the confirm attempt finishes and carries no account column.",
  application_document_storage_aliases:
    "Child of manager_application_records (cascades); keyed on the storage path, not an account.",
  workspace_work_numbers:
    "Workspace <-> work-number assignment join table; keyed on workspace_id/number_id only, no account column — cascades away with portal_workspaces (on delete cascade) when the manager's workspaces are purged.",
  proplane_balance_entries:
    "Child of proplane_balance_accounts (on delete cascade), no account column of its own; the ledger is preserved financial history like ledger_entries, so its parent account row is retained (preserveFinancial) and this child is never reached anyway.",
};

/**
 * `table.column` pairs the coverage guard should not treat as an account key, each with the
 * reason. Contact copies and foreign keys onto other tables live here; an account key never
 * does.
 */
export const NON_OWNERSHIP_COLUMNS: Readonly<Record<string, string>> = {
  "manager_property_owners.owner_email": "Contact address for a third-party property owner, not a PropLane login.",
  "manager_sms_contacts.contact_email": "Denormalized contact address on the manager's own SMS contact row.",
  "vendor_business_profiles.work_email": "The vendor's public business mailbox, keyed by user_id; the row is deleted with the login.",
  // These columns are immutable test-effect provenance. They identify which
  // authenticated test actor and target manager produced an isolated effect;
  // they are deliberately retained with the owning business row so deletion
  // cannot erase its classification or let it be replayed as customer data.
  "action_event_deliveries.sms_test_actor_user_id": "Retained test-effect provenance, not row ownership.",
  "action_event_deliveries.sms_test_manager_user_id": "Retained test-effect target provenance, not row ownership.",
  "action_events.sms_test_actor_user_id": "Retained test-effect provenance, not row ownership.",
  "action_events.sms_test_manager_user_id": "Retained test-effect target provenance, not row ownership.",
  "agent_pending_actions.sms_test_actor_user_id": "Retained test-action provenance, not row ownership.",
  "agent_pending_actions.sms_test_manager_user_id": "Retained test-action target provenance, not row ownership.",
  "agent_sessions.sms_test_manager_user_id": "Retained test-session target provenance, not row ownership.",
  "agent_sessions.sms_test_origin_actor_user_id": "Retained test-session origin provenance, not row ownership.",
  "agent_sessions.sms_test_origin_manager_user_id": "Retained test-session origin target provenance, not row ownership.",
  "agent_sessions.test_actor_user_id": "Retained test-session provenance, not row ownership.",
  "manager_bills.sms_test_actor_user_id": "Retained test-effect provenance, not row ownership.",
  "manager_bills.sms_test_manager_user_id": "Retained test-effect target provenance, not row ownership.",
  "prospect_sms_bursts.test_actor_user_id": "Retained test-message provenance, not row ownership.",
  "prospect_sms_ingress.test_actor_user_id": "Retained test-message provenance, not row ownership.",
  "prospect_tour_bookings.test_actor_user_id": "Retained test-booking provenance, not row ownership.",
  "prospect_tour_google_calendar_cleanup.sms_test_actor_user_id": "Retained test-cleanup provenance, not row ownership.",
  "prospect_tour_google_calendar_cleanup.sms_test_manager_user_id": "Retained test-cleanup target provenance, not row ownership.",
  "prospect_tour_scheduling_state.test_actor_user_id": "Retained test-scheduling provenance, not row ownership.",
  "resident_inspections.sms_test_actor_user_id": "Retained test-inspection provenance, not row ownership.",
  "resident_inspections.sms_test_manager_user_id": "Retained test-inspection target provenance, not row ownership.",
};

export function purgeRulesForScope(scope: PurgeScope, phase: 1 | 2 | 3) {
  return ACCOUNT_PURGE_TABLES.filter((rule) => rule.phase === phase && rule[scope]);
}
