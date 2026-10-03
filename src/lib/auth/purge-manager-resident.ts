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
import { normalizeE164 } from "@/lib/phone-e164";
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
  "bookings",
  "texts",
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
  /**
   * Phone numbers this person texts from (profile + application). The work
   * number's text log is keyed on the phone, so without one nothing in it can
   * be attributed and no text is touched.
   */
  phones?: readonly (string | null | undefined)[];
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
  /** Columns compared to the resident's phone (raw and E.164). */
  phones?: readonly string[];
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
  /** The column must hold one of these values (a record-type allowlist). */
  requireIn?: { column: string; values: readonly string[] };
  /** Extra inequality the row must satisfy (the shared admin inbox is never collateral). */
  exclude?: { column: string; notEquals: string };
  /** Private object path reclaimed after the transaction commits. */
  storage?: { bucket: string; pathColumn: string };
  /**
   * Money really received is kept, not deleted: rows in this state are
   * anonymized in place (every pointer to the person removed) and only the
   * rest are deleted. Read from the row's `status` column / `row_data.status`.
   */
  keepPaidAnonymized?: boolean;
  /** Delete the rows' ledger lines first (the foreign key would otherwise detach them). */
  eraseLedgerLines?: boolean;
};

/**
 * Delete order: children first, the application last. Every table here also
 * carries a manager scope rule in `account-purge-manifest.ts`; the manifest is
 * about whole accounts, this list is about one resident inside one portfolio.
 *
 * Deliberately absent:
 *   * `ledger_entries` / `security_deposit_ledger` / `manager_payment_plans` —
 *     money the manager really received stays in Financials, the same stance
 *     `purgeManagerResidentOrphans` takes. Paid charges, their ledger lines
 *     and held deposits are ANONYMIZED instead (see `keepPaidAnonymized`), so
 *     income and deposit totals still add up with no name attached; only the
 *     accrual lines of the unpaid charges that are deleted go with them.
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
    // Captain, Oct 3: deleting a resident erases them fully — paid charges too.
    eraseLedgerLines: true,
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
    // The Bookings calendar bar for a stay the manager entered by hand names
    // the resident in the block itself. (Lease- and application-backed bars go
    // with their lease / application rows.) Record types are spelled out so a
    // tour slot or availability row that happens to mention the address stays.
    table: "portal_schedule_records",
    category: "bookings",
    managerColumn: "manager_user_id",
    match: { jsonEmails: ["residentEmail"] },
    requireIn: { column: "record_type", values: ["room_date_block", "cancelled_room_date_block"] },
  },
  {
    table: "manager_sms_messages",
    category: "texts",
    managerColumn: "manager_user_id",
    match: { ids: ["resident_user_id"], phones: ["resident_phone"] },
  },
  {
    table: "inbound_sms_log",
    category: "texts",
    managerColumn: "manager_user_id",
    match: { ids: ["matched_sender_user_id"], phones: ["from_phone"] },
  },
  {
    table: "manager_sms_contacts",
    category: "texts",
    managerColumn: "manager_user_id",
    match: { phones: ["phone_e164"] },
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
  /** Table + ids kept but stripped of every pointer to the person. */
  anonymize: { table: string; ids: string[] }[];
  /** Paid charges in the delete: how many, and how much money (erased with the resident since Oct 3). */
  paidKept: { count: number; cents: number };
  applicationIds: string[];
  /** Private objects reclaimed after the delete commits. */
  storage: { documents: { bucket: string; paths: string[] }[]; inspectionIds: string[] };
};

export type ManagerResidentPurgeResult = {
  counts: ManagerResidentPurgeCounts;
  total: number;
  /** Rows kept without a name, per table (paid charges, their ledger lines, deposits). */
  anonymized: Record<string, number>;
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
    bookings: 0,
    texts: 0,
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

/** Raw and E.164 spellings of every phone, so a log written either way matches. */
function phoneVariants(phones: readonly (string | null | undefined)[] | undefined): string[] {
  const out = new Set<string>();
  for (const phone of phones ?? []) {
    const raw = typeof phone === "string" ? phone.trim() : "";
    if (!raw) continue;
    out.add(raw);
    const e164 = normalizeE164(raw);
    if (e164) out.add(e164);
  }
  return [...out];
}

function phoneFromApplicationRow(rowData: unknown): string[] {
  const data = (rowData ?? {}) as {
    application?: { phone?: unknown };
    manualResidentDetails?: { phone?: unknown };
  };
  return [data.application?.phone, data.manualResidentDetails?.phone].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
}

/**
 * Every application id in this portfolio for this resident, plus the phones
 * those applications carry. Screenings, cosigner submissions and inspections
 * are keyed by application id, not by the resident, so they cannot be found
 * without resolving these first; the text log is keyed on phone only.
 */
async function resolveApplications(
  db: ServiceDb,
  identity: ManagerResidentIdentity,
): Promise<{ ids: string[]; phones: string[] }> {
  const ids = new Set<string>();
  const phones: string[] = [];
  const explicit = (identity.applicationId ?? "").trim();
  const email = normalizeEmail(identity.email);

  const { data, error } = await db
    .from("manager_application_records")
    .select("id,resident_email,row_data")
    .eq("manager_user_id", identity.managerUserId);
  if (error) throw new Error(`Could not read this portfolio's applications: ${error.message}`);
  for (const row of data ?? []) {
    const rowId = typeof row.id === "string" ? row.id : "";
    if (!rowId) continue;
    if (rowId === explicit || (email && normalizeEmail(row.resident_email) === email)) {
      ids.add(rowId);
      phones.push(...phoneFromApplicationRow((row as { row_data?: unknown }).row_data));
    }
  }
  return { ids: [...ids], phones };
}

type TargetRow = { id: string; storagePath?: string; paid?: boolean; paidCents?: number };

/** A charge whose money was (at least partly) received: it is kept, never deleted. */
function chargeIsPaid(row: Record<string, unknown>): { paid: boolean; cents: number } {
  const data = (row.row_data ?? {}) as Record<string, unknown>;
  const status = String(row.status ?? data.status ?? "").trim().toLowerCase();
  if (status !== "paid" && status !== "partially_paid") return { paid: false, cents: 0 };
  const cents =
    typeof data.paidAmountCents === "number"
      ? data.paidAmountCents
      : typeof data.amountCents === "number"
        ? data.amountCents
        : 0;
  return { paid: true, cents: cents > 0 ? cents : 0 };
}

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

type LookupScope = { table: string; managerColumn: string; storagePathColumn?: string; extraColumns?: readonly string[] };

async function pageRows(
  db: ServiceDb,
  scope: LookupScope,
  managerUserId: string,
  narrow: (query: RowQuery) => RowQuery,
  base?: (query: RowQuery) => RowQuery,
): Promise<Record<string, unknown>[]> {
  const columns = ["id", scope.storagePathColumn, ...(scope.extraColumns ?? [])].filter(Boolean).join(",");
  return loadAccountCleanupRows<Record<string, unknown>>((from, to) => {
    let query = (db.from(scope.table).select(columns) as unknown as RowQuery).eq(scope.managerColumn, managerUserId);
    if (base) query = base(query);
    return narrow(query).order("id").range(from, to);
  });
}

async function selectTargetRows(
  db: ServiceDb,
  target: ManagerResidentPurgeTarget,
  identity: ManagerResidentIdentity,
  applicationIds: readonly string[],
  phones: readonly string[],
): Promise<TargetRow[]> {
  const email = normalizeEmail(identity.email);
  const residentUserId = (identity.residentUserId ?? "").trim();
  const found = new Map<string, TargetRow>();
  const scope: LookupScope = {
    table: target.table,
    managerColumn: target.managerColumn,
    storagePathColumn: target.storage?.pathColumn,
    extraColumns: target.keepPaidAnonymized || target.eraseLedgerLines ? ["status", "row_data"] : undefined,
  };

  const collect = async (narrow: (query: RowQuery) => RowQuery): Promise<void> => {
    const rows = await pageRows(db, scope, identity.managerUserId, narrow, (query) => {
      let next = query;
      if (target.require) next = next.eq(target.require.column, target.require.equals);
      if (target.requireIn) next = next.in(target.requireIn.column, target.requireIn.values);
      if (target.exclude) next = next.neq(target.exclude.column, target.exclude.notEquals);
      return next;
    });
    for (const row of rows) {
      const id = typeof row.id === "string" ? row.id : String(row.id ?? "");
      if (!id) continue;
      const storagePath = target.storage ? row[target.storage.pathColumn] : undefined;
      const entry: TargetRow = { id, storagePath: typeof storagePath === "string" ? storagePath : undefined };
      if (target.keepPaidAnonymized || target.eraseLedgerLines) {
        const { paid, cents } = chargeIsPaid(row);
        entry.paid = paid;
        entry.paidCents = cents;
      }
      found.set(id, entry);
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
  if (phones.length > 0) {
    for (const column of target.match.phones ?? []) {
      await collect((query) => query.in(column, phones));
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

/** Ledger and deposit rows naming this resident (kept, but unnamed). */
async function selectFinancialRows(
  db: ServiceDb,
  table: "ledger_entries" | "security_deposit_ledger",
  identity: ManagerResidentIdentity,
): Promise<string[]> {
  const email = normalizeEmail(identity.email);
  const residentUserId = (identity.residentUserId ?? "").trim();
  const scope: LookupScope = { table, managerColumn: "manager_user_id" };
  const ids = new Set<string>();
  const add = (rows: Record<string, unknown>[]) => {
    for (const row of rows) ids.add(String(row.id ?? ""));
  };
  if (residentUserId) add(await pageRows(db, scope, identity.managerUserId, (q) => q.eq("resident_user_id", residentUserId)));
  if (email) add(await pageRows(db, scope, identity.managerUserId, (q) => q.ilike("resident_email", literalEmail(email))));
  ids.delete("");
  return [...ids];
}

/** The accrual (`charge`) ledger lines of charges that are being deleted. */
async function selectChargeLedgerLines(
  db: ServiceDb,
  managerUserId: string,
  chargeIds: readonly string[],
): Promise<string[]> {
  const ids = new Set<string>();
  const scope: LookupScope = { table: "ledger_entries", managerColumn: "manager_user_id" };
  for (let i = 0; i < chargeIds.length; i += 100) {
    const batch = chargeIds.slice(i, i + 100);
    const rows = await pageRows(
      db,
      scope,
      managerUserId,
      (q) => q.in("source_charge_id", batch),
      (q) => q.eq("entry_type", "charge"),
    );
    for (const row of rows) ids.add(String(row.id ?? ""));
  }
  ids.delete("");
  return [...ids];
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
    anonymize: [],
    paidKept: { count: 0, cents: 0 },
    applicationIds: [],
    storage: { documents: [], inspectionIds: [] },
  };
  if (!managerUserId) return empty;
  if (!normalizeEmail(identity.email) && !(identity.residentUserId ?? "").trim() && !(identity.applicationId ?? "").trim()) {
    return empty;
  }

  const scoped: ManagerResidentIdentity = { ...identity, managerUserId };
  const applications = await resolveApplications(db, scoped);
  const applicationIds = applications.ids;
  const phones = phoneVariants([...(identity.phones ?? []), ...applications.phones]);
  const targets: { table: string; ids: string[] }[] = [];
  const anonymize: { table: string; ids: string[] }[] = [];
  const paidKept = { count: 0, cents: 0 };
  const documentPaths: string[] = [];
  const inspectionIds: string[] = [];
  let total = 0;

  for (const target of MANAGER_RESIDENT_PURGE_TARGETS) {
    const found = await selectTargetRows(db, target, scoped, applicationIds, phones);
    // Paid money is kept (unnamed); only the charges nothing was received on go.
    const kept = target.keepPaidAnonymized ? found.filter((row) => row.paid) : [];
    const rows = target.keepPaidAnonymized ? found.filter((row) => !row.paid) : found;
    if (kept.length > 0) {
      anonymize.push({ table: target.table, ids: kept.map((row) => row.id) });
      paidKept.count += kept.length;
      paidKept.cents += kept.reduce((sum, row) => sum + (row.paidCents ?? 0), 0);
    }
    if (target.eraseLedgerLines) {
      // What the delete preview shows as "Paid payments": money received that goes with them.
      const paid = rows.filter((row) => row.paid);
      paidKept.count += paid.length;
      paidKept.cents += paid.reduce((sum, row) => sum + (row.paidCents ?? 0), 0);
    }
    if ((target.keepPaidAnonymized || target.eraseLedgerLines) && rows.length > 0) {
      // A deleted charge takes its accrual line with it; the line must go first
      // or the foreign key detaches it and it is left in the books unattached.
      const lines = await selectChargeLedgerLines(db, managerUserId, rows.map((row) => row.id));
      if (lines.length > 0) targets.push({ table: "ledger_entries", ids: lines });
    }
    if (rows.length === 0) continue;
    targets.push({ table: target.table, ids: rows.map((row) => row.id) });
    counts[target.category] += rows.length;
    total += rows.length;
    if (target.table === "resident_inspections") inspectionIds.push(...rows.map((row) => row.id));
    if (target.storage) {
      for (const row of rows) if (row.storagePath) documentPaths.push(row.storagePath);
    }
  }

  // Erased fully (captain, Oct 3): every remaining ledger line and deposit row
  // that names them goes too, deleted BEFORE the charges they may point at.
  const deletedLedger = new Set(targets.filter((t) => t.table === "ledger_entries").flatMap((t) => t.ids));
  const ledger = (await selectFinancialRows(db, "ledger_entries", scoped)).filter((id) => !deletedLedger.has(id));
  const deposits = await selectFinancialRows(db, "security_deposit_ledger", scoped);
  const financial: { table: string; ids: string[] }[] = [];
  if (deposits.length > 0) financial.push({ table: "security_deposit_ledger", ids: deposits });
  if (ledger.length > 0) financial.push({ table: "ledger_entries", ids: ledger });
  targets.unshift(...financial);

  return {
    counts,
    total,
    targets,
    anonymize,
    paidKept,
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
 * transaction: bookings, messages, texts, every charge (paid too), their ledger
 * lines and deposit rows — the resident is erased fully (captain, Oct 3). Throws without changing anything when
 * the transaction cannot complete, so the caller can leave the row in the list
 * and say so.
 */
export async function purgeManagerResidentData(
  db: ServiceDb,
  identity: ManagerResidentIdentity,
): Promise<ManagerResidentPurgeResult> {
  const managerUserId = identity.managerUserId.trim();
  const preview = await previewManagerResidentPurge(db, { ...identity, managerUserId });
  if (preview.targets.length === 0 && preview.anonymize.length === 0) {
    return { counts: preview.counts, total: 0, anonymized: {}, storageWarnings: [] };
  }

  const { data, error } = await db.rpc("purge_manager_resident_rows_v2", {
    p_manager: managerUserId,
    p_targets: preview.targets,
    p_anonymize: preview.anonymize,
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

  const payload = (data ?? {}) as { deleted?: Record<string, unknown>; anonymized?: Record<string, unknown> };
  const counts = emptyCounts();
  let total = 0;
  for (const [table, removed] of Object.entries(payload.deleted ?? {})) {
    const category = categoryOf(table);
    const count = typeof removed === "number" ? removed : Number(removed ?? 0);
    if (!category || !Number.isFinite(count)) continue;
    counts[category] += count;
    total += count;
  }
  const anonymized: Record<string, number> = {};
  for (const [table, changed] of Object.entries(payload.anonymized ?? {})) {
    const count = typeof changed === "number" ? changed : Number(changed ?? 0);
    if (Number.isFinite(count) && count > 0) anonymized[table] = count;
  }

  return { counts, total, anonymized, storageWarnings: await reclaimStorage(db, managerUserId, preview) };
}
