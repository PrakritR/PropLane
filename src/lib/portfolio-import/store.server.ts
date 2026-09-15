import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { summarizePortfolioImportDraft } from "@/lib/portfolio-import/build-draft";
import type {
  PortfolioImportDraft,
  PortfolioImportRecordKind,
  PortfolioImportSourcePreset,
  PortfolioImportSourceKind,
  PortfolioImportSourceTable,
  PortfolioImportStatus,
  PortfolioImportSummary,
} from "@/lib/portfolio-import/types";

/**
 * Portfolio import — the DB layer for `manager_portfolio_imports` /
 * `manager_portfolio_import_records` (supabase/migrations/20260915000000_manager_portfolio_imports.sql).
 *
 * The `draft` jsonb column carries `{ version: 1, table, draft }` so a column
 * re-map (PATCH .../portfolio-import/[importId] with `columns`) can rebuild
 * the draft from the ORIGINAL source table without re-reading the file.
 *
 * Receipts (`manager_portfolio_import_records`) follow the sales-migration
 * pattern (docs/agents/sales-migration.md): insert-only "prepared" rows keyed
 * by a deterministic source key, a payload hash pins the exact record the
 * receipt was prepared for, and only a matching hash may complete it. A
 * commit that stops halfway resumes from the receipts already completed and
 * never creates a duplicate canonical record.
 */

export type PortfolioImportStoredDraft = {
  version: 1;
  table: PortfolioImportSourceTable;
  draft: PortfolioImportDraft;
};

export type PortfolioImportRow = {
  id: string;
  manager_user_id: string;
  source_kind: PortfolioImportSourceKind;
  preset: PortfolioImportSourcePreset;
  file_name: string;
  file_sha256: string;
  status: PortfolioImportStatus;
  draft: PortfolioImportStoredDraft | null;
  result: unknown;
  created_at: string;
  updated_at: string;
  committed_at: string | null;
};

export class PortfolioImportDuplicateError extends Error {
  readonly importId: string;
  constructor(importId: string) {
    super("An import for this exact file is already in progress.");
    this.name = "PortfolioImportDuplicateError";
    this.importId = importId;
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function check(error: { message: string } | null): void {
  if (error) throw new Error(error.message);
}

export async function createPortfolioImport(input: {
  db: SupabaseClient;
  managerUserId: string;
  sourceKind: PortfolioImportSourceKind;
  preset: PortfolioImportSourcePreset;
  fileName: string;
  fileSha256: string;
  table: PortfolioImportSourceTable;
  draft: PortfolioImportDraft;
}): Promise<PortfolioImportRow> {
  const { db, managerUserId, sourceKind, preset, fileName, fileSha256, table, draft } = input;
  const storedDraft: PortfolioImportStoredDraft = { version: 1, table, draft };
  const { data, error } = await db
    .from("manager_portfolio_imports")
    .insert({
      manager_user_id: managerUserId,
      source_kind: sourceKind,
      preset,
      file_name: fileName,
      file_sha256: fileSha256,
      status: "draft",
      draft: storedDraft,
    })
    .select("*")
    .single();

  if (error) {
    // 23505 = unique_violation on manager_portfolio_imports_owner_file_active.
    if ((error as { code?: string }).code === "23505") {
      const { data: existing } = await db
        .from("manager_portfolio_imports")
        .select("id")
        .eq("manager_user_id", managerUserId)
        .eq("file_sha256", fileSha256)
        .neq("status", "discarded")
        .maybeSingle();
      if (existing?.id) throw new PortfolioImportDuplicateError(String(existing.id));
    }
    throw new Error(error.message);
  }
  return data as PortfolioImportRow;
}

export async function loadPortfolioImport(
  db: SupabaseClient,
  managerUserId: string,
  importId: string,
): Promise<PortfolioImportRow | null> {
  const { data, error } = await db
    .from("manager_portfolio_imports")
    .select("*")
    .eq("id", importId)
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  check(error);
  return (data as PortfolioImportRow | null) ?? null;
}

export async function listPortfolioImports(
  db: SupabaseClient,
  managerUserId: string,
  limit = 20,
): Promise<PortfolioImportRow[]> {
  const { data, error } = await db
    .from("manager_portfolio_imports")
    .select("*")
    .eq("manager_user_id", managerUserId)
    .order("created_at", { ascending: false })
    .limit(limit);
  check(error);
  return (data ?? []) as PortfolioImportRow[];
}

export async function updatePortfolioImportDraft(
  db: SupabaseClient,
  managerUserId: string,
  importId: string,
  input: { table: PortfolioImportSourceTable; draft: PortfolioImportDraft },
): Promise<PortfolioImportRow> {
  const storedDraft: PortfolioImportStoredDraft = { version: 1, table: input.table, draft: input.draft };
  const { data, error } = await db
    .from("manager_portfolio_imports")
    .update({ draft: storedDraft, status: "draft", updated_at: new Date().toISOString() })
    .eq("id", importId)
    .eq("manager_user_id", managerUserId)
    .select("*")
    .single();
  check(error);
  return data as PortfolioImportRow;
}

export async function setPortfolioImportStatus(
  db: SupabaseClient,
  managerUserId: string,
  importId: string,
  status: PortfolioImportStatus,
  opts: { result?: unknown; committedAt?: string | null } = {},
): Promise<PortfolioImportRow> {
  const patch: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
  if (opts.result !== undefined) patch.result = opts.result;
  if (opts.committedAt !== undefined) patch.committed_at = opts.committedAt;
  const { data, error } = await db
    .from("manager_portfolio_imports")
    .update(patch)
    .eq("id", importId)
    .eq("manager_user_id", managerUserId)
    .select("*")
    .single();
  check(error);
  return data as PortfolioImportRow;
}

export async function discardPortfolioImport(
  db: SupabaseClient,
  managerUserId: string,
  importId: string,
): Promise<void> {
  const { error } = await db
    .from("manager_portfolio_imports")
    .update({ status: "discarded", updated_at: new Date().toISOString() })
    .eq("id", importId)
    .eq("manager_user_id", managerUserId);
  check(error);
}

export type PortfolioImportReceiptRow = {
  id: string;
  import_id: string;
  manager_user_id: string;
  record_kind: PortfolioImportRecordKind;
  source_key: string;
  payload_hash: string;
  status: "prepared" | "completed";
  canonical_id: string | null;
  error: string | null;
};

export async function loadReceipts(
  db: SupabaseClient,
  importId: string,
): Promise<PortfolioImportReceiptRow[]> {
  const { data, error } = await db
    .from("manager_portfolio_import_records")
    .select("*")
    .eq("import_id", importId);
  check(error);
  return (data ?? []) as PortfolioImportReceiptRow[];
}

function payloadHash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/**
 * Insert-only prepare: a re-run of the same commit hits the same deterministic
 * `sourceKey` and either finds the identical payload hash already there (safe
 * to proceed/resume) or a changed one (a real conflict — the caller decides).
 */
export async function prepareReceipt(
  db: SupabaseClient,
  input: {
    importId: string;
    managerUserId: string;
    recordKind: PortfolioImportRecordKind;
    sourceKey: string;
    payload: unknown;
  },
): Promise<PortfolioImportReceiptRow> {
  const hash = payloadHash(input.payload);
  const { error: insertError } = await db.from("manager_portfolio_import_records").upsert(
    {
      import_id: input.importId,
      manager_user_id: input.managerUserId,
      record_kind: input.recordKind,
      source_key: input.sourceKey,
      payload_hash: hash,
    },
    { onConflict: "import_id,record_kind,source_key", ignoreDuplicates: true },
  );
  check(insertError);
  const { data, error } = await db
    .from("manager_portfolio_import_records")
    .select("*")
    .eq("import_id", input.importId)
    .eq("record_kind", input.recordKind)
    .eq("source_key", input.sourceKey)
    .single();
  check(error);
  const row = data as PortfolioImportReceiptRow;
  if (row.payload_hash === hash) return row;
  // A record that already landed must not be silently rewritten from a changed
  // draft — that is a conflict, never permission to overwrite. A record that is
  // still only prepared (an earlier attempt failed, the manager fixed the row and
  // is retrying) simply takes the new payload.
  if (row.status === "completed") {
    throw new Error("This record changed since it was imported — it was left as it is.");
  }
  const { data: refreshed, error: refreshError } = await db
    .from("manager_portfolio_import_records")
    .update({ payload_hash: hash, error: null })
    .eq("id", row.id)
    .select("*")
    .single();
  check(refreshError);
  return refreshed as PortfolioImportReceiptRow;
}

export async function completeReceipt(
  db: SupabaseClient,
  importId: string,
  recordKind: PortfolioImportRecordKind,
  sourceKey: string,
  canonicalId: string,
): Promise<void> {
  const { error } = await db
    .from("manager_portfolio_import_records")
    .update({ status: "completed", canonical_id: canonicalId, completed_at: new Date().toISOString(), error: null })
    .eq("import_id", importId)
    .eq("record_kind", recordKind)
    .eq("source_key", sourceKey);
  check(error);
}

export async function failReceipt(
  db: SupabaseClient,
  importId: string,
  recordKind: PortfolioImportRecordKind,
  sourceKey: string,
  message: string,
): Promise<void> {
  const { error } = await db
    .from("manager_portfolio_import_records")
    .update({ error: message })
    .eq("import_id", importId)
    .eq("record_kind", recordKind)
    .eq("source_key", sourceKey);
  check(error);
}

export function summaryFor(row: PortfolioImportRow): PortfolioImportSummary | null {
  if (!row.draft) return null;
  return summarizePortfolioImportDraft(row.draft.draft, {
    importId: row.id,
    status: row.status,
    createdAt: row.created_at,
    committedAt: row.committed_at,
  });
}
