import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import {
  ACCOUNT_PURGE_TABLES,
  type PurgeScope,
  type PurgeScopeRule,
  type PurgeTableRule,
} from "@/lib/auth/account-purge-manifest";
import { purgeCoManagerReferencesToUser } from "@/lib/auth/purge-orphaned-co-manager-links";
import { MANAGER_DOCUMENTS_BUCKET } from "@/lib/documents/manager-documents";
import { reclaimApplicationPhotos } from "@/lib/rental-application/application-photos.server";

type ServiceDb = ReturnType<typeof createSupabaseServiceRoleClient>;
type WriteResult = { error: { message: string } | null };
type WriteOp = PromiseLike<WriteResult>;

function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function looksLikeMissingTableError(err: { message?: string } | null | undefined): boolean {
  const m = (err?.message ?? "").toLowerCase();
  return (
    m.includes("schema cache") ||
    m.includes("does not exist") ||
    (m.includes("relation") && m.includes("not"))
  );
}

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
): WriteOp[] {
  const ops: WriteOp[] = [];
  const restrict = scopeRule.restrict;
  const guard = <T extends { neq: (column: string, value: string) => T }>(query: T): T =>
    restrict ? query.neq(restrict.column, restrict.notEquals) : query;

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
      ops.push(guard(db.from(rule.table).delete().eq(column, target.email)) as unknown as WriteOp);
    }
    for (const column of scopeRule.detachEmails ?? []) {
      ops.push(
        guard(db.from(rule.table).update({ [column]: null }).eq(column, target.email)) as unknown as WriteOp,
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
): Promise<void> {
  if (!target.userId && !target.email) return;
  for (const phase of [1, 2, 3] as const) {
    const ops = ACCOUNT_PURGE_TABLES.filter((rule) => rule.phase === phase).flatMap((rule) => {
      const scopeRule = rule[scope];
      return scopeRule ? scopedWrites(db, rule, scopeRule, target) : [];
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
function residentJsonWrites(db: ServiceDb, email: string, userId: string): WriteOp[] {
  const ops: WriteOp[] = [];
  if (email) {
    ops.push(
      db.from("portal_household_charge_records").delete().filter("row_data->>residentEmail", "eq", email),
      db.from("portal_recurring_rent_profile_records").delete().filter("row_data->>residentEmail", "eq", email),
      db.from("portal_lease_pipeline_records").delete().filter("row_data->>residentEmail", "eq", email),
      db.from("portal_work_order_records").delete().filter("row_data->>residentEmail", "eq", email),
      db.from("portal_service_request_records").delete().filter("row_data->>residentEmail", "eq", email),
      db.from("portal_resident_lease_upload_records").delete().filter("row_data->>residentEmail", "eq", email),
      db.from("portal_inbox_thread_records").delete().filter("row_data->>email", "eq", email),
      db.from("portal_inbox_thread_records").delete().filter("row_data->>fromEmail", "eq", email),
      db.from("portal_scheduled_inbox_message_records").delete().filter("row_data->>recipientEmail", "eq", email),
      db.from("portal_scheduled_inbox_message_records").delete().filter("row_data->>senderEmail", "eq", email),
    );
  }
  if (userId) {
    ops.push(
      db.from("portal_scheduled_inbox_message_records").delete().filter("row_data->>senderUserId", "eq", userId),
      db.from("portal_scheduled_inbox_message_records").delete().filter("row_data->>recipientUserId", "eq", userId),
    );
  }
  return ops;
}

/** Remove leases, payments, applications, and other portal rows for a resident. */
export async function purgeResidentPortalData(
  db: ServiceDb,
  input: { email?: string; userId?: string | null; applicationId?: string | null },
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
    const { data: appRows } = await db
      .from("manager_application_records")
      .select("id")
      .eq("resident_email", email);
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
      db.from("portal_household_charge_records").delete().filter("row_data->>applicationId", "eq", applicationId),
      db.from("portal_lease_pipeline_records").delete().filter("row_data->>axisId", "eq", applicationId),
      db.from("cosigner_submission_records").delete().eq("signer_app_id", applicationId),
      db.from("screening_orders").delete().eq("application_id", applicationId),
    );
  }

  deleteOps.push(...residentJsonWrites(db, email, userId));

  if (deleteOps.length > 0) assertNoDeleteErrors(await Promise.all(deleteOps));
  await runManifestPurge(db, "resident", { userId, email });

  // Only after the rows are really gone: best-effort, never blocks the purge.
  await Promise.allSettled([...photoReclaimIds].map((id) => reclaimApplicationPhotos(db, id)));
}

/** Remove portal rows keyed to one application without touching the resident login. */
export async function purgeApplicationPortalData(db: ServiceDb, applicationId: string): Promise<void> {
  const appId = applicationId.trim();
  if (!appId) return;

  const deleteOps: WriteOp[] = [
    db.from("manager_application_records").delete().eq("id", appId),
    db.from("portal_household_charge_records").delete().filter("row_data->>applicationId", "eq", appId),
    db.from("portal_lease_pipeline_records").delete().filter("row_data->>axisId", "eq", appId),
    db.from("cosigner_submission_records").delete().eq("signer_app_id", appId),
    db.from("screening_orders").delete().eq("application_id", appId),
  ];

  assertNoDeleteErrors(await Promise.all(deleteOps));
  await reclaimApplicationPhotos(db, appId).catch(() => undefined);
}

/**
 * Remove the private storage objects behind the manager's own document library (leases,
 * insurance, tax PDFs) before the rows pointing at them go. Best-effort: a storage error or
 * a missing table on an older database must never block the account deletion.
 */
async function removeManagerDocumentObjects(db: ServiceDb, managerUserId: string): Promise<void> {
  try {
    const { data: docRows } = await db
      .from("manager_documents")
      .select("storage_path")
      .eq("manager_user_id", managerUserId);
    const storagePaths = (docRows ?? [])
      .map((row) => (row as { storage_path?: unknown }).storage_path)
      .filter((path): path is string => typeof path === "string" && path.length > 0);
    if (storagePaths.length > 0) {
      await db.storage.from(MANAGER_DOCUMENTS_BUCKET).remove(storagePaths);
    }
  } catch {
    /* best-effort storage cleanup */
  }
}

/** Remove properties, resident records, payments, leases, and other portal rows for a manager. */
export async function purgeManagerPortalData(db: ServiceDb, managerUserId: string): Promise<void> {
  if (!managerUserId) return;

  const { data: profileRow } = await db.from("profiles").select("email").eq("id", managerUserId).maybeSingle();
  const email = normalizeEmail(profileRow?.email);

  await purgeCoManagerReferencesToUser(db, managerUserId);

  // Applicant ID / income photos ride with the application rows deleted below —
  // resolve those ids first so their private uploads are reclaimed too.
  const { data: managerAppRows } = await db
    .from("manager_application_records")
    .select("id")
    .eq("manager_user_id", managerUserId);
  const managerApplicationIds = (managerAppRows ?? [])
    .map((row) => (row as { id?: unknown }).id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  await removeManagerDocumentObjects(db, managerUserId);
  await runManifestPurge(db, "manager", { userId: managerUserId, email });

  if (email) {
    // `manager_purchases.user_id` is `on delete set null`, and older rows were written with
    // whatever casing the signup form carried, so match the address case-insensitively too.
    assertNoDeleteErrors(await Promise.all([db.from("manager_purchases").delete().ilike("email", email)]));
  }

  await Promise.allSettled(managerApplicationIds.map((id) => reclaimApplicationPhotos(db, id)));
}

/**
 * Remove the vendor account's own rows and detach the manager-owned directory / dispatch
 * references to it. Vendor data is keyed by `vendor_user_id`, which neither the manager nor
 * the resident purge covers.
 */
export async function purgeVendorPortalData(
  db: ServiceDb,
  input: { userId: string; email?: string },
): Promise<void> {
  const userId = input.userId.trim();
  if (!userId) return;
  await runManifestPurge(db, "vendor", { userId, email: normalizeEmail(input.email) });
}
