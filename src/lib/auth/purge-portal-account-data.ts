import { isResidentOriginatedScheduledRow } from "@/lib/scheduled-inbox-messages";
import { purgeAccountStorageFolder } from "@/lib/auth/purge-account-storage";
import { loadAccountCleanupRows } from "@/lib/auth/load-account-cleanup-rows";
import { ADMIN_INBOX_SCOPE } from "@/lib/portal-inbox-thread-scope";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import {
  ACCOUNT_PURGE_TABLES,
  type PurgeScope,
  type PurgeScopeRule,
  type PurgeTableRule,
} from "@/lib/auth/account-purge-manifest";
import { purgeCoManagerReferencesToUser } from "@/lib/auth/purge-orphaned-co-manager-links";
import { MANAGER_DOCUMENTS_BUCKET } from "@/lib/documents/manager-documents";
import { applicationPhotoFolderKey } from "@/lib/rental-application/application-photos.server";

type ServiceDb = ReturnType<typeof createSupabaseServiceRoleClient>;
type WriteResult = { error: { message: string } | null };
type WriteOp = PromiseLike<WriteResult>;

function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function looksLikeMissingTableError(err: { message?: string; code?: string } | null | undefined): boolean {
  return err?.code === "42P01" || err?.code === "PGRST205";
}

function literalEmail(email: string): string {
  return email.replace(/[\\%_]/g, "\\$&");
}

const SHARED_ACCOUNT_TABLES = new Set([
  "notification_preferences", "agent_user_preferences", "device_push_tokens",
  "phone_verifications", "sms_consent", "resident_housemate_sharing",
  "mcp_oauth_authorization_codes", "mcp_oauth_tokens",
]);
const PORTAL_HISTORY_TABLES = new Set(["agent_sessions", "agent_messages", "agent_pending_actions"]);

function assertNoDeleteErrors(results: { error: { message: string } | null }[]) {
  const failed = results.find((result) => result.error && !looksLikeMissingTableError(result.error));
  if (failed?.error) throw new Error(failed.error.message);
}

/**
 * Statements for one manifest row in one scope. Deletes come first, then the "detach"
 * updates that null a pointer on a row belonging to someone else.
 */
function scopedWrites(
  db: ServiceDb,
  rule: PurgeTableRule,
  scopeRule: PurgeScopeRule,
  target: { userId: string; email: string },
  portal?: PurgeScope,
): WriteOp[] {
  if (portal === "vendor" && rule.table === "sms_relay_bindings") return [];
  const ops: WriteOp[] = [];
  const restrict = scopeRule.restrict;
  const guard = <T extends { neq: (column: string, value: string) => T; eq: (column: string, value: string) => T }>(query: T): T => {
    let result = restrict ? query.neq(restrict.column, restrict.notEquals) : query;
    if (portal && rule.table === "sms_relay_bindings") result = result.eq("role", portal);
    if (portal && PORTAL_HISTORY_TABLES.has(rule.table)) result = result.eq("portal", portal);
    if (portal && rule.table === "portal_inbox_thread_records") result = result.eq("scope", `axis_portal_inbox_${portal}_v1`);
    return result;
  };

  if (scopeRule.preserveFinancial) {
    return [db.rpc("account_preserve_financial_records", {
      p_table: rule.table, p_user: target.userId, p_email: target.email,
      p_ids: [...(scopeRule.ids ?? [])], p_emails: [...(scopeRule.emails ?? [])],
    })];
  }
  if (target.userId) {
    for (const column of scopeRule.ids ?? []) {
      ops.push(guard(db.from(rule.table).delete().eq(column, target.userId)) as unknown as WriteOp);
    }
    for (const column of scopeRule.detachIds ?? []) {
      ops.push(
        guard(db.from(rule.table).update({ [column]: null }).eq(column, target.userId)) as unknown as WriteOp,
      );
    }
  }
  if (target.email) {
    for (const column of scopeRule.emails ?? []) {
      ops.push(guard(db.from(rule.table).delete().ilike(column, literalEmail(target.email))) as unknown as WriteOp);
    }
    for (const column of scopeRule.detachEmails ?? []) {
      ops.push(
        guard(db.from(rule.table).update({ [column]: null }).ilike(column, literalEmail(target.email))) as unknown as WriteOp,
      );
    }
  }
  return ops;
}

/**
 * Run the manifest for one account scope, phase by phase. Statements inside a phase run
 * together; phases run in order so a child delete never races the cascade already removing
 * it. A table missing from an older database is tolerated, any other error aborts.
 */
async function runManifestPurge(
  db: ServiceDb,
  scope: PurgeScope,
  target: { userId: string; email: string },
  complete = true,
): Promise<void> {
  if (!target.userId && !target.email) return;
  for (const phase of [1, 2, 3, 4] as const) {
    const ops = ACCOUNT_PURGE_TABLES.filter((rule) => rule.phase === phase).flatMap((rule) => {
      if (!complete && SHARED_ACCOUNT_TABLES.has(rule.table)) return [];
      const scopeRule = rule[scope];
      return scopeRule ? scopedWrites(db, rule, scopeRule, target, complete ? undefined : scope) : [];
    });
    if (ops.length === 0) continue;
    assertNoDeleteErrors(await Promise.all(ops));
  }
}

/**
 * Rows keyed only inside `row_data` JSON. They exist because the portal record tables store
 * their payload as JSON and the promoted columns were added later, so a row written before
 * the promotion carries the identity only in the blob.
 */
function residentJsonWrites(db: ServiceDb, email: string, complete = true): WriteOp[] {
  const inbox = () => {
    const query = db.from("portal_inbox_thread_records").delete().neq("scope", ADMIN_INBOX_SCOPE);
    return complete ? query : query.eq("scope", "axis_portal_inbox_resident_v1");
  };
  const ops: WriteOp[] = [];
  if (email) {
    ops.push(
      db.from("portal_recurring_rent_profile_records").delete().filter("row_data->>residentEmail", "ilike", literalEmail(email)),
      db.from("portal_work_order_records").delete().filter("row_data->>residentEmail", "ilike", literalEmail(email)),
      db.from("portal_service_request_records").delete().filter("row_data->>residentEmail", "ilike", literalEmail(email)),
      db.from("portal_resident_lease_upload_records").delete().filter("row_data->>residentEmail", "ilike", literalEmail(email)),
      inbox().filter("row_data->>email", "ilike", literalEmail(email)),
      inbox().filter("row_data->>fromEmail", "ilike", literalEmail(email)),
    );
  }
  return ops;
}

async function purgeResidentScheduledMessages(db: ServiceDb, email: string, userId: string, complete: boolean) {
  const found = new Map<string, { id: string; row_data: Record<string, unknown> }>();
  for (const [column, value, op] of [
    ["senderUserId", userId, "eq"], ["recipientUserId", userId, "eq"],
    ["senderEmail", email, "ilike"], ["recipientEmail", email, "ilike"],
  ]) {
    if (!value) continue;
    const rows = await loadAccountCleanupRows<{ id: string; row_data: Record<string, unknown> }>((from, to) => db
      .from("portal_scheduled_inbox_message_records").select("id,row_data")
      .filter(`row_data->>${column}`, op, op === "ilike" ? literalEmail(value) : value).order("id").range(from, to));
    for (const row of rows) {
      const residentSender = isResidentOriginatedScheduledRow(row.row_data);
      const senderMatch = column.startsWith("sender");
      if (complete || senderMatch === residentSender) found.set(row.id, row);
    }
  }
  const ids = [...found.keys()];
  for (let from = 0; from < ids.length; from += 100) {
    const { error } = await db.from("portal_scheduled_inbox_message_records").delete().in("id", ids.slice(from, from + 100));
    if (error) throw new Error(error.message);
  }
}

/** Remove leases, payments, applications, and other portal rows for a resident. */
export async function purgeResidentPortalData(
  db: ServiceDb,
  input: { email?: string; userId?: string | null; applicationId?: string | null; complete?: boolean },
): Promise<void> {
  const email = normalizeEmail(input.email);
  const userId = (input.userId ?? "").trim();
  const applicationId = typeof input.applicationId === "string" ? input.applicationId.trim() : "";

  // Every application row this purge hard-deletes must also reclaim its private
  // application-documents uploads (applicant ID / income photos) — retention
  // Option A: the photos live exactly as long as the row.
  const photoReclaimIds = new Set<string>();
  const deleteOps: WriteOp[] = [];

  if (email) {
    // The resident's own screening (background-check) orders and cosigner
    // submissions are keyed by application id (not email/user id), so resolve this
    // resident's application ids and purge those child rows too — otherwise
    // sensitive third-party-check PII orphans after a "permanent" account delete.
    const appRows = await loadAccountCleanupRows<{ id: string }>((from, to) => db
      .from("manager_application_records").select("id").ilike("resident_email", literalEmail(email)).order("id").range(from, to));
    const applicationIds = (appRows ?? [])
      .map((row) => (row as { id?: unknown }).id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    for (const id of applicationIds) photoReclaimIds.add(id);
    if (applicationIds.length > 0) {
      deleteOps.push(
        db.from("screening_orders").delete().in("application_id", applicationIds),
        db.from("cosigner_submission_records").delete().in("signer_app_id", applicationIds),
      );
    }
  }

  if (applicationId) {
    photoReclaimIds.add(applicationId);
    deleteOps.push(
      db.from("manager_application_records").delete().eq("id", applicationId),
      db.from("cosigner_submission_records").delete().eq("signer_app_id", applicationId),
      db.from("screening_orders").delete().eq("application_id", applicationId),
    );
  }

  const inspections = new Map<string, { id: string; manager_user_id: string }>();
  for (const column of ["resident_user_id", "resident_email"] as const) {
    const identity = column === "resident_user_id" ? userId : email;
    if (!identity) continue;
    const reports = await loadAccountCleanupRows<{ id: string; manager_user_id: string }>((from, to) => {
      const query = db.from("resident_inspections").select("id,manager_user_id").order("id").range(from, to);
      return column === "resident_user_id" ? query.eq(column, identity) : query.ilike(column, literalEmail(identity));
    });
    for (const report of reports) inspections.set(report.id, report);
  }
  for (const report of inspections.values()) await purgeAccountStorageFolder(db, "inspection-evidence", `${report.manager_user_id}/${report.id}`);

  // Keep the application rows (and therefore the paths) until bytes are gone.
  for (const id of photoReclaimIds) await purgeAccountStorageFolder(db, "application-documents", `application/${applicationPhotoFolderKey(id)}`);
  await purgeResidentScheduledMessages(db, email, userId, input.complete !== false);
  deleteOps.push(...residentJsonWrites(db, email, input.complete !== false));

  if (deleteOps.length > 0) assertNoDeleteErrors(await Promise.all(deleteOps));
  await runManifestPurge(db, "resident", { userId, email }, input.complete !== false);

}

/** Remove portal rows keyed to one application without touching the resident login. */
export async function purgeApplicationPortalData(db: ServiceDb, applicationId: string): Promise<void> {
  const appId = applicationId.trim();
  if (!appId) return;

  const deleteOps: WriteOp[] = [
    db.from("manager_application_records").delete().eq("id", appId),
    db.from("cosigner_submission_records").delete().eq("signer_app_id", appId),
    db.from("screening_orders").delete().eq("application_id", appId),
  ];

  await purgeAccountStorageFolder(db, "application-documents", `application/${applicationPhotoFolderKey(appId)}`);
  assertNoDeleteErrors(await Promise.all(deleteOps));
}

/**
 * Remove the private storage objects behind the manager's own document library (leases,
 * insurance, tax PDFs) before the rows pointing at them go. Best-effort: a storage error or
 * a missing table on an older database must never block the account deletion.
 */
async function removeManagerDocumentObjects(db: ServiceDb, managerUserId: string): Promise<void> {
  for (let from = 0; ; from += 100) {
    const { data, error } = await db.from("manager_documents").select("storage_path").eq("manager_user_id", managerUserId).order("id").range(from, from + 99);
    if (error) throw new Error(error.message);
    const paths = (data ?? []).map(row => row.storage_path).filter((path): path is string => typeof path === "string" && !!path);
    if (paths.length) {
      const { error: removeError } = await db.storage.from(MANAGER_DOCUMENTS_BUCKET).remove(paths);
      if (removeError) throw new Error(removeError.message);
    }
    if ((data?.length ?? 0) < 100) return;
  }
}

/** Remove properties, resident records, payments, leases, and other portal rows for a manager. */
export async function purgeManagerPortalData(db: ServiceDb, managerUserId: string, complete = true, verifiedEmail?: string): Promise<void> {
  if (!managerUserId) return;

  const { data: identity, error: identityError } = verifiedEmail === undefined ? await db.auth.admin.getUserById(managerUserId) : { data: { user: { email: verifiedEmail } }, error: null };
  if (identityError) throw new Error(identityError.message);
  const email = normalizeEmail(identity.user?.email);

  await purgeCoManagerReferencesToUser(db, managerUserId);

  // Applicant ID / income photos ride with the application rows deleted below —
  // resolve those ids first so their private uploads are reclaimed too.
  const managerAppRows = await loadAccountCleanupRows<{ id: string }>((from, to) => db
    .from("manager_application_records").select("id").eq("manager_user_id", managerUserId).order("id").range(from, to));
  const managerApplicationIds = (managerAppRows ?? [])
    .map((row) => (row as { id?: unknown }).id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  await removeManagerDocumentObjects(db, managerUserId);
  for (const id of managerApplicationIds) await purgeAccountStorageFolder(db, "application-documents", `application/${applicationPhotoFolderKey(id)}`);
  for (const [bucket, folder] of [
    ["manager-documents", `manager/${managerUserId}`], ["listing-photos", managerUserId],
    ["lease-templates", managerUserId], ["inspection-evidence", managerUserId],
    ["sms-media", `manager/${managerUserId}`],
  ]) await purgeAccountStorageFolder(db, bucket, folder);
  await runManifestPurge(db, "manager", { userId: managerUserId, email }, complete);

  if (email) {
    // `manager_purchases.user_id` is `on delete set null`, and older rows were written with
    // whatever casing the signup form carried, so match the address case-insensitively too.
    assertNoDeleteErrors(await Promise.all([db.from("manager_purchases").delete().ilike("email", literalEmail(email))]));
  }

}

/**
 * Remove the vendor account's own rows and detach the manager-owned directory / dispatch
 * references to it. Vendor data is keyed by `vendor_user_id`, which neither the manager nor
 * the resident purge covers.
 */
export async function purgeVendorPortalData(
  db: ServiceDb,
  input: { userId: string; email?: string; complete?: boolean },
): Promise<void> {
  const userId = input.userId.trim();
  if (!userId) return;
  await purgeAccountStorageFolder(db, "vendor-documents", `vendor-documents/${userId}`);
  await runManifestPurge(db, "vendor", { userId, email: normalizeEmail(input.email) }, input.complete !== false);
}
