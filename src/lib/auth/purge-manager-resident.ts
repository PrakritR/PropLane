/**
 * Deleting a resident from a manager's portfolio removes everything in that
 * portfolio linked to them — or nothing.
 *
 * Why this exists next to `purgeResidentPortalData`: that one deletes a
 * resident's whole ACCOUNT across every manager, and a manager may not do
 * that. `purgeApplicationPortalData` goes the other way and deletes only the
 * application row, which is what left proplane.ai showing bookings, charges and
 * services for residents the manager had already deleted — the browser fired
 * the lease / charge / service deletes itself and never read the answers.
 *
 * The split of work:
 *   * this module resolves and authorizes — which rows in WHICH manager's
 *     portfolio belong to this resident, matched by email, auth user id, or one
 *     of their application ids, table by table;
 *   * `purge_manager_resident_rows` (service-role RPC) performs the deletes in
 *     one transaction, so a failure part-way rolls all of them back.
 *
 * Preview and delete read the same target table in the same order, so the
 * counts in the confirm dialog are the counts the delete acts on.
 */

import { ADMIN_INBOX_SCOPE } from "@/lib/portal-inbox-thread-scope";
import { MANAGER_DOCUMENTS_BUCKET } from "@/lib/documents/manager-documents";
import { applicationPhotoFolderKey } from "@/lib/rental-application/application-photos.server";
import { loadAccountCleanupRows } from "@/lib/auth/load-account-cleanup-rows";
import { purgeAccountStorageFolder } from "@/lib/auth/purge-account-storage";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

type ServiceDb = ReturnType<typeof createSupabaseServiceRoleClient>;

/**
 * The buckets the confirm dialog names. User-facing copy says "service", never
 * "work order": maintenance rows and add-on requests are two tables under one
 * Services count.
 */
export const MANAGER_RESIDENT_PURGE_CATEGORIES = [
  "leases",
  "charges",
  "services",
  "inspections",
  "documents",
  "conversations",
  "applications",
] as const;

export type ManagerResidentPurgeCategory = (typeof MANAGER_RESIDENT_PURGE_CATEGORIES)[number];

export type ManagerResidentPurgeCounts = Record<ManagerResidentPurgeCategory, number>;

export type ManagerResidentIdentity = {
  /** The portfolio being cleared. Never read from a request body. */
  managerUserId: string;
  email?: string | null;
  residentUserId?: string | null;
  applicationId?: string | null;
};

type MatchRule = {
  /** Columns compared to the resident's auth user id. */
  ids?: readonly string[];
  /** Columns compared case-insensitively to the resident's email. */
  emails?: readonly string[];
  /** `row_data->>key` compared case-insensitively to the resident's email. */
  jsonEmails?: readonly string[];
  /** Columns holding one of the resident's application ids. */
  applicationIds?: readonly string[];
  /** The row's own id is an application id (the application record itself). */
  selfApplicationId?: boolean;
};

export type ManagerResidentPurgeTarget = {
  table: string;
  category: ManagerResidentPurgeCategory;
  /** The column that must equal `managerUserId`. The RPC re-checks it. */
  managerColumn: string;
  match: MatchRule;
  /** Extra equality the row must satisfy to be in scope. */
  require?: { column: string; equals: string };
  /** Extra inequality the row must satisfy (the shared admin inbox is never collateral). */
  exclude?: { column: string; notEquals: string };
  /** Private object path reclaimed after the transaction commits. */
  storage?: { bucket: string; pathColumn: string };
};

/**
 * Delete order: children first, the application last. Every table here also
 * carries a manager scope rule in `account-purge-manifest.ts`; the manifest is
 * about whole accounts, this list is about one resident inside one portfolio.
 *
 * Deliberately absent:
 *   * `ledger_entries` / `security_deposit_ledger` / `manager_payment_plans` —
 *     money the manager really received stays in Financials, the same stance
 *     `purgeManagerResidentOrphans` takes.
 *   * `portal_resident_lease_upload_records` — a resident's own upload, with no
 *     manager column to scope it by.
 */
export const MANAGER_RESIDENT_PURGE_TARGETS: readonly ManagerResidentPurgeTarget[] = [
  {
    table: "cosigner_submission_records",
    category: "applications",
    managerColumn: "manager_user_id",
    match: { applicationIds: ["signer_app_id"] },
  },
  {
    table: "screening_orders",
    category: "applications",
    managerColumn: "manager_user_id",
    match: { applicationIds: ["application_id"] },
  },
  {
    table: "portal_reminder_records",
    category: "conversations",
    managerColumn: "manager_user_id",
    match: { emails: ["recipient_email"] },
    // The manager's own copy of the same reminder is their record, not the resident's.
    require: { column: "recipient_role", equals: "resident" },
  },
  {
    table: "payment_reminder_occurrences",
    category: "conversations",
    managerColumn: "manager_user_id",
    match: { emails: ["recipient_email"] },
  },
  {
    table: "resident_autopay_runs",
    category: "charges",
    managerColumn: "manager_id",
    match: { ids: ["resident_user_id"] },
  },
  {
    table: "resident_autopay_settings",
    category: "charges",
    managerColumn: "manager_id",
    match: { ids: ["resident_user_id"] },
  },
  {
    table: "portal_household_charge_records",
    category: "charges",
    managerColumn: "manager_user_id",
    match: { ids: ["resident_user_id"], emails: ["resident_email"] },
  },
  {
    table: "portal_recurring_rent_profile_records",
    category: "charges",
    managerColumn: "manager_user_id",
    match: { ids: ["resident_user_id"], emails: ["resident_email"] },
  },
  {
    table: "portal_service_request_records",
    category: "services",
    managerColumn: "manager_user_id",
    match: { emails: ["resident_email"] },
  },
  {
    table: "portal_scheduled_inbox_message_records",
    category: "conversations",
    managerColumn: "manager_user_id",
    // No promoted recipient column on this table; the address is in the payload.
    match: { jsonEmails: ["recipientEmail", "senderEmail"] },
  },
  {
    table: "resident_inspections",
    category: "inspections",
    managerColumn: "manager_user_id",
    match: { ids: ["resident_user_id"], emails: ["resident_email"], applicationIds: ["application_id"] },
  },
  {
    table: "portal_lease_pipeline_records",
    category: "leases",
    managerColumn: "manager_user_id",
    match: { ids: ["resident_user_id"], emails: ["resident_email"] },
  },
  {
    table: "portal_work_order_records",
    category: "services",
    managerColumn: "manager_user_id",
    match: { emails: ["resident_email"] },
  },
  {
    table: "manager_documents",
    category: "documents",
    managerColumn: "manager_user_id",
    match: { ids: ["resident_user_id"], emails: ["resident_email"] },
    storage: { bucket: MANAGER_DOCUMENTS_BUCKET, pathColumn: "storage_path" },
  },
  {
    table: "portal_inbox_thread_records",
    category: "conversations",
    managerColumn: "owner_user_id",
    match: { emails: ["participant_email"] },
    exclude: { column: "scope", notEquals: ADMIN_INBOX_SCOPE },
  },
  {
    table: "manager_application_records",
    category: "applications",
    managerColumn: "manager_user_id",
    match: { emails: ["resident_email"], selfApplicationId: true },
  },
];

export type ManagerResidentPurgePreview = {
  counts: ManagerResidentPurgeCounts;
  total: number;
  /** Table + ids in delete order, exactly what the RPC receives. */
  targets: { table: string; ids: string[] }[];
  applicationIds: string[];
  /** Private objects reclaimed after the delete commits. */
  storage: { documents: { bucket: string; paths: string[] }[]; inspectionIds: string[] };
};

export type ManagerResidentPurgeResult = {
  counts: ManagerResidentPurgeCounts;
  total: number;
  /** Object paths the delete could not reclaim. The rows are already gone. */
  storageWarnings: string[];
};

function emptyCounts(): ManagerResidentPurgeCounts {
  return {
    leases: 0,
    charges: 0,
    services: 0,
    inspections: 0,
    documents: 0,
    conversations: 0,
    applications: 0,
  };
}

function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** `ilike` treats these as wildcards; a resident's address must match literally. */
function literalEmail(email: string): string {
  return email.replace(/[\\%_]/g, "\\$&");
}

function categoryOf(table: string): ManagerResidentPurgeCategory | null {
  return MANAGER_RESIDENT_PURGE_TARGETS.find((target) => target.table === table)?.category ?? null;
}

/**
 * Every application id in this portfolio for this resident. Screenings, cosigner
 * submissions and inspections are keyed by application id, not by the resident,
 * so they cannot be found without resolving these first.
 */
async function resolveApplicationIds(db: ServiceDb, identity: ManagerResidentIdentity): Promise<string[]> {
  const ids = new Set<string>();
  const explicit = (identity.applicationId ?? "").trim();
  const email = normalizeEmail(identity.email);

  const { data, error } = await db
    .from("manager_application_records")
    .select("id,resident_email")
    .eq("manager_user_id", identity.managerUserId);
  if (error) throw new Error(`Could not read this portfolio's applications: ${error.message}`);
  for (const row of data ?? []) {
    const rowId = typeof row.id === "string" ? row.id : "";
    if (!rowId) continue;
    if (rowId === explicit) ids.add(rowId);
    else if (email && normalizeEmail(row.resident_email) === email) ids.add(rowId);
  }
  return [...ids];
}

type TargetRow = { id: string; storagePath?: string };

/**
 * The read surface a target query needs. Spelled out structurally because the
 * generated PostgREST builder types are resolved per table + per select string,
 * and a generic walk over 16 tables makes the checker give up (TS2589).
 */
type RowQuery = {
  eq: (column: string, value: string) => RowQuery;
  neq: (column: string, value: string) => RowQuery;
  ilike: (column: string, value: string) => RowQuery;
  in: (column: string, values: readonly string[]) => RowQuery;
  filter: (column: string, operator: string, value: string) => RowQuery;
  order: (column: string) => RowQuery;
  range: (from: number, to: number) => PromiseLike<{
    data: Record<string, unknown>[] | null;
    error: { code?: string; message: string } | null;
  }>;
};

async function selectTargetRows(
  db: ServiceDb,
  target: ManagerResidentPurgeTarget,
  identity: ManagerResidentIdentity,
  applicationIds: readonly string[],
): Promise<TargetRow[]> {
  const email = normalizeEmail(identity.email);
  const residentUserId = (identity.residentUserId ?? "").trim();
  const columns = ["id", target.storage?.pathColumn].filter(Boolean).join(",");
  const found = new Map<string, TargetRow>();

  const collect = async (narrow: (query: RowQuery) => RowQuery): Promise<void> => {
    const rows = await loadAccountCleanupRows<Record<string, unknown>>((from, to) => {
      let query = (
        db.from(target.table).select(columns) as unknown as RowQuery
      ).eq(target.managerColumn, identity.managerUserId);
      if (target.require) query = query.eq(target.require.column, target.require.equals);
      if (target.exclude) query = query.neq(target.exclude.column, target.exclude.notEquals);
      return narrow(query).order("id").range(from, to);
    });
    for (const row of rows) {
      const id = typeof row.id === "string" ? row.id : String(row.id ?? "");
      if (!id) continue;
      const storagePath = target.storage ? row[target.storage.pathColumn] : undefined;
      found.set(id, { id, storagePath: typeof storagePath === "string" ? storagePath : undefined });
    }
  };

  if (residentUserId) {
    for (const column of target.match.ids ?? []) {
      await collect((query) => query.eq(column, residentUserId));
    }
  }
  if (email) {
    for (const column of target.match.emails ?? []) {
      await collect((query) => query.ilike(column, literalEmail(email)));
    }
    for (const key of target.match.jsonEmails ?? []) {
      await collect((query) => query.filter(`row_data->>${key}`, "ilike", literalEmail(email)));
    }
  }
  if (applicationIds.length > 0) {
    for (const column of target.match.applicationIds ?? []) {
      await collect((query) => query.in(column, applicationIds));
    }
    if (target.match.selfApplicationId) {
      await collect((query) => query.in("id", applicationIds));
    }
  }

  return [...found.values()];
}

/**
 * What a delete would remove, per category, without removing anything. The
 * confirm dialog shows these numbers and the delete replays the same resolution.
 */
export async function previewManagerResidentPurge(
  db: ServiceDb,
  identity: ManagerResidentIdentity,
): Promise<ManagerResidentPurgePreview> {
  const managerUserId = identity.managerUserId.trim();
  const counts = emptyCounts();
  const empty: ManagerResidentPurgePreview = {
    counts,
    total: 0,
    targets: [],
    applicationIds: [],
    storage: { documents: [], inspectionIds: [] },
  };
  if (!managerUserId) return empty;
  if (!normalizeEmail(identity.email) && !(identity.residentUserId ?? "").trim() && !(identity.applicationId ?? "").trim()) {
    return empty;
  }

  const scoped: ManagerResidentIdentity = { ...identity, managerUserId };
  const applicationIds = await resolveApplicationIds(db, scoped);
  const targets: { table: string; ids: string[] }[] = [];
  const documentPaths: string[] = [];
  const inspectionIds: string[] = [];
  let total = 0;

  for (const target of MANAGER_RESIDENT_PURGE_TARGETS) {
    const rows = await selectTargetRows(db, target, scoped, applicationIds);
    if (rows.length === 0) continue;
    targets.push({ table: target.table, ids: rows.map((row) => row.id) });
    counts[target.category] += rows.length;
    total += rows.length;
    if (target.table === "resident_inspections") inspectionIds.push(...rows.map((row) => row.id));
    if (target.storage) {
      for (const row of rows) if (row.storagePath) documentPaths.push(row.storagePath);
    }
  }

  return {
    counts,
    total,
    targets,
    applicationIds,
    storage: {
      documents: documentPaths.length > 0 ? [{ bucket: MANAGER_DOCUMENTS_BUCKET, paths: documentPaths }] : [],
      inspectionIds,
    },
  };
}

/**
 * Reclaim the private bytes the deleted rows pointed at. Runs only after the
 * transaction commits: bytes removed before a failed delete could not be put
 * back, and a storage error must not report a completed delete as failed.
 */
async function reclaimStorage(
  db: ServiceDb,
  managerUserId: string,
  preview: ManagerResidentPurgePreview,
): Promise<string[]> {
  const warnings: string[] = [];
  for (const group of preview.storage.documents) {
    for (let i = 0; i < group.paths.length; i += 100) {
      const { error } = await db.storage.from(group.bucket).remove(group.paths.slice(i, i + 100));
      if (error) warnings.push(`${group.bucket}: ${error.message}`);
    }
  }
  for (const inspectionId of preview.storage.inspectionIds) {
    try {
      await purgeAccountStorageFolder(db, "inspection-evidence", `${managerUserId}/${inspectionId}`);
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : "inspection-evidence cleanup failed");
    }
  }
  for (const applicationId of preview.applicationIds) {
    try {
      await purgeAccountStorageFolder(
        db,
        "application-documents",
        `application/${applicationPhotoFolderKey(applicationId)}`,
      );
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : "application-documents cleanup failed");
    }
  }
  return warnings;
}

/**
 * Remove every row in this manager's portfolio linked to the resident, in one
 * transaction. Throws without deleting anything when the transaction cannot
 * complete, so the caller can leave the row in the list and say so.
 */
export async function purgeManagerResidentData(
  db: ServiceDb,
  identity: ManagerResidentIdentity,
): Promise<ManagerResidentPurgeResult> {
  const managerUserId = identity.managerUserId.trim();
  const preview = await previewManagerResidentPurge(db, { ...identity, managerUserId });
  if (preview.total === 0) {
    return { counts: preview.counts, total: 0, storageWarnings: [] };
  }

  const { data, error } = await db.rpc("purge_manager_resident_rows", {
    p_manager: managerUserId,
    p_targets: preview.targets,
  });
  if (error) {
    // PGRST202 is "function not found" — an environment that has not run
    // `npm run db:push`. Never fall back to statement-by-statement deletes: a
    // partial delete is the failure this whole path exists to prevent.
    const hint =
      (error as { code?: string }).code === "PGRST202"
        ? " Run `npm run db:push` so the resident cascade is installed."
        : "";
    throw new Error(`Nothing was deleted: ${error.message}.${hint}`);
  }

  const counts = emptyCounts();
  let total = 0;
  for (const [table, removed] of Object.entries((data ?? {}) as Record<string, unknown>)) {
    const category = categoryOf(table);
    const count = typeof removed === "number" ? removed : Number(removed ?? 0);
    if (!category || !Number.isFinite(count)) continue;
    counts[category] += count;
    total += count;
  }

  return { counts, total, storageWarnings: await reclaimStorage(db, managerUserId, preview) };
}
