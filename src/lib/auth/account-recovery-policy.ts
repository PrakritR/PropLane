import { ACCOUNT_PURGE_TABLES, type PurgeScope } from "@/lib/auth/account-purge-manifest";

export const ACCOUNT_RECOVERY_DAYS = 30;
export const ACCOUNT_RECOVERY_PATH = "/auth/recover-account";

/** These are the surviving manager's books, not disposable resident profile data. */
export const RESIDENT_FINANCIAL_HISTORY_TABLES = new Set([
  "ledger_entries", "security_deposit_ledger", "manager_payment_plans",
  "portal_household_charge_records", "portal_lease_pipeline_records",
]);

/** Never replay credentials, money-moving configuration or previously queued actions. */
export const ACCOUNT_RECOVERY_NEVER_RESTORE = new Set([
  "webhook_subscriptions", "webhook_deliveries",
  "manager_api_keys", "mcp_oauth_authorization_codes", "mcp_oauth_tokens",
  "phone_verifications", "device_push_tokens", "sms_consent", "sms_consent_events",
  "agent_pending_actions", "action_events", "action_event_deliveries",
  "document_share_links", "portal_record_share_links", "vendor_invites",
  "manager_invite_links", "manager_invite_link_redemptions", "resident_invite_claims", "account_link_invites",
  "portal_pro_relationship_records", "manager_property_access", "manager_property_owners",
  "sms_relay_bindings", "sms_relay_threads", "sms_relay_messages", "sms_relay_numbers", "sms_outbox",
  "sms_delivery_attempts", "sms_delivery_events", "sms_provisioning_operations",
  "portal_scheduled_inbox_message_records", "portal_reminder_records",
  "portal_recurring_rent_profile_records", "scheduled_message_overrides",
  "manager_automation_settings", "manager_billing_settings", "manager_purchases",
  "sms_manager_entitlements", "manager_comms_billing_accounts", "manager_sms_numbers",
  "manager_assistant_emails", "external_calendar_connections", "resident_tour_links",
]);

const ACCOUNT_SHARED = new Set([
  "notification_preferences", "agent_user_preferences", "device_push_tokens",
  "phone_verifications", "sms_consent", "mcp_oauth_authorization_codes", "mcp_oauth_tokens",
  "resident_housemate_sharing",
]);

const JSON_EMAIL_FIELDS: Record<string, string[]> = {
  portal_household_charge_records: ["residentEmail"],
  portal_recurring_rent_profile_records: ["residentEmail"],
  portal_lease_pipeline_records: ["residentEmail"],
  portal_work_order_records: ["residentEmail"],
  portal_service_request_records: ["residentEmail"],
  portal_resident_lease_upload_records: ["residentEmail"],
  portal_inbox_thread_records: ["email", "fromEmail"],
  portal_scheduled_inbox_message_records: ["recipientEmail", "senderEmail"],
};

export type AccountArchiveRule = {
  table: string;
  phase: number;
  ids: readonly string[];
  emails: readonly string[];
  jsonEmails: readonly string[];
  detachIds: readonly string[];
  detachEmails: readonly string[];
  retainFinancial: boolean;
  recover: boolean;
  portal?: string;
  scope?: string;
  bindingRole?: string;
  restrict?: { column: string; notEquals: string };
};

/** Uses Prakrit's ownership catalog; recovery only adds lifecycle/preservation policy. */
export function accountArchiveRules(scope: PurgeScope, complete: boolean): AccountArchiveRule[] {
  return ACCOUNT_PURGE_TABLES.flatMap(rule => {
    const owner = rule[scope];
    if (!owner || (!complete && ACCOUNT_SHARED.has(rule.table)) || (!complete && scope === "vendor" && rule.table === "sms_relay_bindings")) return [];
    return [{
      table: rule.table, phase: rule.phase,
      ids: owner.ids ?? [], emails: owner.emails ?? [],
      jsonEmails: scope === "resident" ? JSON_EMAIL_FIELDS[rule.table] ?? [] : [],
      detachIds: owner.detachIds ?? [], detachEmails: owner.detachEmails ?? [],
      retainFinancial: owner.preserveFinancial === true,
      recover: !ACCOUNT_RECOVERY_NEVER_RESTORE.has(rule.table),
      ...(!complete && ["agent_sessions", "agent_messages", "agent_pending_actions"].includes(rule.table)
        ? { portal: scope } : {}),
      ...(!complete && rule.table === "portal_inbox_thread_records" ? { scope: `axis_portal_inbox_${scope}_v1` } : {}),
      ...(!complete && rule.table === "sms_relay_bindings" ? { bindingRole: scope } : {}),
      ...(owner.restrict ? { restrict: owner.restrict } : {}),
    }];
  });
}

export function normalizeRecoveryPortal(value: string): PurgeScope | null {
  if (["manager", "owner", "pro"].includes(value)) return "manager";
  return value === "resident" || value === "vendor" ? value : null;
}

export const ACCOUNT_RECOVERABLE_TABLES = [...ACCOUNT_PURGE_TABLES.map(rule => rule.table), "application_document_storage_aliases"].filter(table => !ACCOUNT_RECOVERY_NEVER_RESTORE.has(table));
