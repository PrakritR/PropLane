import "server-only";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { ACCOUNT_PURGE_TABLES, type PurgeScopeRule } from "@/lib/auth/account-purge-manifest";
import { EXPORT_EXCLUDED_KEY_PATTERNS, stripExcludedExportKeys } from "@/lib/account-export/pii-exclusion";

type ServiceDb = ReturnType<typeof createSupabaseServiceRoleClient>;

export const EXPORT_SCHEMA_VERSION = 1;

/** PostgREST caps a single select at 1000 rows; page through anything bigger. */
const PAGE_SIZE = 1000;
/**
 * Hard ceiling per table so one runaway log table cannot exhaust the function's memory.
 * The manifest says when it was hit — a silent cut would read as "that is all there was".
 */
export const MAX_ROWS_PER_TABLE = 20_000;

export type ManagerExportTable = {
  table: string;
  idColumns: readonly string[];
  emailColumns: readonly string[];
  restrict?: PurgeScopeRule["restrict"];
};

export type ExportTableSummary = {
  rows: number;
  truncated?: true;
  /** The table does not exist on this database (older schema); nothing was read. */
  unavailable?: true;
};

export type ExportManifest = {
  format: "proplane-export";
  schemaVersion: number;
  exportedAt: string;
  managerId: string;
  tableCount: number;
  rowCount: number;
  tables: Record<string, ExportTableSummary>;
  excludedKeyPatterns: readonly string[];
};

export type ManagerExport = {
  manifest: ExportManifest;
  tables: Record<string, unknown[]>;
};

/**
 * Every table the manager OWNS, straight from the purge manifest: a table is in the
 * export exactly when the purge would DELETE its rows for a manager (`ids` / `emails`).
 * A `detachIds` / `detachEmails`-only rule is somebody else's record that merely points at
 * this account (a resident's audit trail, a vendor's directory entry) and is not theirs to
 * take. Deriving from the manifest means a table classified for deletion is exported
 * without a second list to forget to update.
 */
export function managerExportTables(): ManagerExportTable[] {
  return ACCOUNT_PURGE_TABLES.flatMap((rule) => {
    const scope = rule.manager;
    const idColumns = scope?.ids ?? [];
    const emailColumns = scope?.emails ?? [];
    if (!scope || (idColumns.length === 0 && emailColumns.length === 0)) return [];
    return [{ table: rule.table, idColumns, emailColumns, restrict: scope.restrict }];
  }).sort((a, b) => a.table.localeCompare(b.table));
}

function looksLikeMissingTableError(err: { message?: string } | null | undefined): boolean {
  const m = (err?.message ?? "").toLowerCase();
  return (
    m.includes("schema cache") ||
    m.includes("does not exist") ||
    (m.includes("relation") && m.includes("not"))
  );
}

function rowKey(row: unknown): string {
  const id = row && typeof row === "object" ? (row as { id?: unknown }).id : undefined;
  return typeof id === "string" || typeof id === "number" ? `id:${id}` : `row:${JSON.stringify(row)}`;
}

async function readColumn(
  db: ServiceDb,
  spec: ManagerExportTable,
  column: string,
  value: string,
  sink: Map<string, unknown>,
  limit: number,
): Promise<{ truncated: boolean; unavailable: boolean }> {
  let from = 0;
  for (;;) {
    let query = db.from(spec.table).select("*").eq(column, value).range(from, from + PAGE_SIZE - 1);
    if (spec.restrict) query = query.neq(spec.restrict.column, spec.restrict.notEquals);
    const { data, error } = await query;
    if (error) {
      if (looksLikeMissingTableError(error)) return { truncated: false, unavailable: true };
      throw new Error(`Export read failed for ${spec.table}: ${error.message}`);
    }
    const rows = (data ?? []) as unknown[];
    for (const row of rows) {
      if (sink.size >= limit) return { truncated: true, unavailable: false };
      const key = rowKey(row);
      if (!sink.has(key)) sink.set(key, stripExcludedExportKeys(row));
    }
    if (rows.length < PAGE_SIZE) return { truncated: false, unavailable: false };
    from += PAGE_SIZE;
  }
}

/**
 * Read-only walk of every manager-owned table for ONE account. `userId` and `email` come
 * from the authenticated session — never from the request — and every select is pinned to
 * them. Rows reachable through more than one column (a purchase keyed by both `user_id`
 * and `email`) are returned once. Excluded keys are stripped before a row is retained, so
 * nothing this function returns has ever held an identity number.
 */
export async function collectManagerExport(
  db: ServiceDb,
  target: { userId: string; email: string },
  options: { now?: Date; maxRowsPerTable?: number } = {},
): Promise<ManagerExport> {
  const userId = target.userId.trim();
  const email = target.email.trim().toLowerCase();
  if (!userId) throw new Error("A manager id is required to export.");
  const limit = options.maxRowsPerTable ?? MAX_ROWS_PER_TABLE;

  const tables: Record<string, unknown[]> = {};
  const summaries: Record<string, ExportTableSummary> = {};
  let rowCount = 0;

  for (const spec of managerExportTables()) {
    const sink = new Map<string, unknown>();
    let truncated = false;
    let unavailable = false;
    const reads: [string, string][] = [
      ...spec.idColumns.map((column): [string, string] => [column, userId]),
      ...(email ? spec.emailColumns.map((column): [string, string] => [column, email]) : []),
    ];
    for (const [column, value] of reads) {
      const result = await readColumn(db, spec, column, value, sink, limit);
      truncated ||= result.truncated;
      unavailable ||= result.unavailable;
      if (unavailable) break;
    }
    const rows = [...sink.values()];
    tables[spec.table] = rows;
    rowCount += rows.length;
    summaries[spec.table] = {
      rows: rows.length,
      ...(truncated ? { truncated: true as const } : {}),
      ...(unavailable ? { unavailable: true as const } : {}),
    };
  }

  const manifest: ExportManifest = {
    format: "proplane-export",
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: (options.now ?? new Date()).toISOString(),
    managerId: userId,
    tableCount: Object.keys(tables).length,
    rowCount,
    tables: summaries,
    excludedKeyPatterns: EXPORT_EXCLUDED_KEY_PATTERNS,
  };

  return { manifest, tables };
}
