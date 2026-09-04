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
];

export const EMAIL_COLUMNS = ["resident_email", "participant_email", "vendor_email", "email"];

/**
 * Delete order, coarsest dependency first.
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
  "gl_journal_lines",
  "ledger_entries",
  "security_deposit_ledger",
  "gl_journal_entries",
  "work_order_bids",
  "work_order_vendor_offers",
  "vendor_invoices",
  "vendor_payouts",
  "vendor_tax_profiles",
  "vendor_availability_rules",
  "vendor_invites",
  "manager_vendor_records",
  "portal_work_order_records",
  "portal_service_request_records",
  "portal_lease_pipeline_records",
  "portal_household_charge_records",
  "portal_schedule_records",
  "portal_inbox_thread_records",
  "manager_document_records",
  "manager_task_records",
  "agent_pending_actions",
  "agent_sessions",
  "manager_sms_numbers",
  "manager_assistant_emails",
  "manager_purchases",
  "account_link_invites",
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
