import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ImportItemStatus,
  ImportPropertyProposal,
  ImportResidentProposal,
  PortfolioImportFileKind,
  PortfolioImportProposal,
  PortfolioImportProposalSummary,
} from "@/lib/portfolio-import/types";
import { residentGaps } from "@/lib/portfolio-import/propose";

/**
 * Portfolio import (rebuilt) — the DB layer for `manager_portfolio_imports` /
 * `manager_portfolio_import_records`
 * (supabase/migrations/20260915000000_manager_portfolio_imports.sql, widened
 * additively by 20260920240000_portfolio_import_rebuild.sql).
 *
 * The rebuild stores the NEW `PortfolioImportProposal` shape
 * (src/lib/portfolio-import/types.ts) in the same `draft` jsonb column the
 * old header-matching import used, tagged `{version: 2, proposal}` so it can
 * never be confused with a pre-rebuild `{version: 1, table, draft}` row (that
 * shape is never read by this module — `loadImport` treats it as absent).
 * `files_name`/`source_kind`/`file_sha256`/`preset` stay best-effort single-
 * file mirrors (first file) for the existing indexes and for anyone reading
 * the row outside this module; the authoritative multi-file list is the new
 * `files` jsonb column.
 *
 * Receipts (`manager_portfolio_import_records`) reuse the exact insert-only
 * "prepared" -> "completed" pattern the old store used (itself following
 * docs/agents/sales-migration.md): a deterministic source key, a payload hash
 * that pins the exact proposal item a receipt was prepared for, and a commit
 * that stops partway resumes from whatever already completed. This rebuild
 * reuses `record_kind = 'balance'` for every `ImportChargeProposal` (rent,
 * deposit, and balance itself) because the column's check constraint was
 * never widened for the new three-kind charge model — `source_key` carries
 * the charge's own key, which already disambiguates kind (`create.server.ts`
 * keys it `${chargeKey}`, and `ImportChargeProposal.kind` is redundantly
 * recorded in the receipt's own payload for anyone reading the row).
 */

export type PortfolioImportRecordKind = "property" | "room" | "resident" | "balance" | "task";

export type PortfolioImportStatus =
  | "uploaded"
  | "draft"
  | "committing"
  | "completed"
  | "partial"
  | "failed"
  | "discarded";

type StoredProposalV2 = { version: 2; proposal: PortfolioImportProposal };

export type PortfolioImportRow = {
  id: string;
  manager_user_id: string;
  source_kind: string;
  preset: string;
  file_name: string;
  file_sha256: string | null;
  files: { name: string; kind: PortfolioImportFileKind }[] | null;
  status: PortfolioImportStatus;
  draft: StoredProposalV2 | { version: 1 } | null;
  result: unknown;
  created_at: string;
  updated_at: string;
  committed_at: string | null;
};

function check(error: { message: string } | null): void {
  if (error) throw new Error(error.message);
}

/** Best-effort single-file mirrors for the legacy NOT-NULL-turned-nullable columns. */
function legacyMirror(files: { name: string; kind: PortfolioImportFileKind }[]): {
  file_name: string;
  source_kind: "csv" | "xlsx" | "pdf";
  preset: "appfolio" | "buildium" | "generic" | "pdf";
} {
  const first = files[0];
  const file_name = files.length > 1 ? `${first?.name ?? "file"} (+${files.length - 1} more)` : (first?.name ?? "import");
  const ext = (first?.name ?? "").toLowerCase();
  const source_kind: "csv" | "xlsx" | "pdf" = ext.endsWith(".pdf") ? "pdf" : /\.(xlsx|xlsm|xls|ods|numbers)$/.test(ext) ? "xlsx" : "csv";
  const kind = first?.kind ?? "unknown";
  const preset: "appfolio" | "buildium" | "generic" | "pdf" =
    kind === "appfolio" ? "appfolio" : kind === "buildium" ? "buildium" : kind === "lease_pdf" || kind === "rent_roll_pdf" ? "pdf" : "generic";
  return { file_name, source_kind, preset };
}

export async function createPortfolioImportProposal(input: {
  db: SupabaseClient;
  managerUserId: string;
  proposal: PortfolioImportProposal;
}): Promise<PortfolioImportRow> {
  const { db, managerUserId, proposal } = input;
  const stored: StoredProposalV2 = { version: 2, proposal };
  const mirror = legacyMirror(proposal.files);
  const { data, error } = await db
    .from("manager_portfolio_imports")
    .insert({
      id: proposal.importId,
      manager_user_id: managerUserId,
      source_kind: mirror.source_kind,
      preset: mirror.preset,
      file_name: mirror.file_name,
      file_sha256: null,
      files: proposal.files,
      status: "draft",
      draft: stored,
    })
    .select("*")
    .single();
  check(error);
  return data as PortfolioImportRow;
}

function proposalOf(row: PortfolioImportRow): PortfolioImportProposal | null {
  const draft = row.draft;
  if (!draft || typeof draft !== "object" || (draft as { version?: unknown }).version !== 2) return null;
  return (draft as StoredProposalV2).proposal;
}

export async function loadImportProposal(
  db: SupabaseClient,
  managerUserId: string,
  importId: string,
): Promise<{ row: PortfolioImportRow; proposal: PortfolioImportProposal } | null> {
  const { data, error } = await db
    .from("manager_portfolio_imports")
    .select("*")
    .eq("id", importId)
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  check(error);
  if (!data) return null;
  const row = data as PortfolioImportRow;
  const proposal = proposalOf(row);
  if (!proposal) return null;
  return { row, proposal };
}

export async function updateImportProposal(
  db: SupabaseClient,
  managerUserId: string,
  importId: string,
  proposal: PortfolioImportProposal,
): Promise<void> {
  const stored: StoredProposalV2 = { version: 2, proposal };
  const { error } = await db
    .from("manager_portfolio_imports")
    .update({ draft: stored, updated_at: new Date().toISOString() })
    .eq("id", importId)
    .eq("manager_user_id", managerUserId);
  check(error);
}

export async function setImportStatus(
  db: SupabaseClient,
  managerUserId: string,
  importId: string,
  status: PortfolioImportStatus,
  opts: { result?: unknown; committedAt?: string | null } = {},
): Promise<void> {
  const patch: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
  if (opts.result !== undefined) patch.result = opts.result;
  if (opts.committedAt !== undefined) patch.committed_at = opts.committedAt;
  const { error } = await db.from("manager_portfolio_imports").update(patch).eq("id", importId).eq("manager_user_id", managerUserId);
  check(error);
}

// ---------------------------------------------------------------------------
// Receipts — resumable, idempotent per-record creation bookkeeping.
// ---------------------------------------------------------------------------

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

async function payloadHash(payload: unknown): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export async function prepareReceipt(
  db: SupabaseClient,
  input: { importId: string; managerUserId: string; recordKind: PortfolioImportRecordKind; sourceKey: string; payload: unknown },
): Promise<PortfolioImportReceiptRow> {
  const hash = await payloadHash(input.payload);
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

export async function loadReceipts(db: SupabaseClient, importId: string): Promise<PortfolioImportReceiptRow[]> {
  const { data, error } = await db.from("manager_portfolio_import_records").select("*").eq("import_id", importId);
  check(error);
  return (data ?? []) as PortfolioImportReceiptRow[];
}

// ---------------------------------------------------------------------------
// Pure helpers shared by the routes and the agent tool.
// ---------------------------------------------------------------------------

/** Merge PATCH/create-time answers and skips into a proposal, recomputing status/summary. */
export function applyAnswersAndSkips(
  proposal: PortfolioImportProposal,
  input: { answers?: Record<string, Partial<ImportResidentProposal>>; skips?: string[] },
): PortfolioImportProposal {
  const answers = input.answers ?? {};
  const skips = new Set(input.skips ?? []);

  const properties: ImportPropertyProposal[] = proposal.properties.map((property) => {
    const propertySkipped = skips.has(property.key);
    const hasMultipleRooms = property.rooms.length > 1;
    const residents: ImportResidentProposal[] = property.residents.map((resident) => {
      const answer = answers[resident.key];
      const merged: ImportResidentProposal = answer ? { ...resident, ...answer, key: resident.key } : resident;
      const skipped = propertySkipped || skips.has(resident.key);
      const gaps = skipped ? [] : residentGaps(merged, hasMultipleRooms);
      const status: ImportItemStatus = skipped ? "skip" : gaps.length > 0 ? "needs" : "ready";
      return { ...merged, status, gaps };
    });
    const status: ImportItemStatus = propertySkipped ? "skip" : residents.some((r) => r.status === "needs") ? "needs" : "ready";
    return { ...property, residents, status };
  });

  return { ...proposal, properties, summary: summarize(properties) };
}

export function summarize(properties: ImportPropertyProposal[]): PortfolioImportProposalSummary {
  let rooms = 0;
  let residents = 0;
  let charges = 0;
  let tasks = 0;
  let gaps = 0;
  for (const property of properties) {
    if (property.status === "skip") continue;
    rooms += property.rooms.length;
    for (const resident of property.residents) {
      if (resident.status === "skip") continue;
      residents += 1;
      gaps += resident.gaps.length;
    }
    charges += property.charges.length;
    tasks += property.tasks.length;
  }
  return { properties: properties.filter((p) => p.status !== "skip").length, rooms, residents, charges, tasks, gaps };
}
