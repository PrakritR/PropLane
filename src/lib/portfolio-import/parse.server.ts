import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { TraceActor } from "@/lib/observability/langfuse";
import { buildPortfolioImportDraft } from "@/lib/portfolio-import/build-draft";
import { applyManualColumnMapping, mapPortfolioImportHeaders } from "@/lib/portfolio-import/column-map";
import { mapUnknownHeadersWithAi } from "@/lib/portfolio-import/column-map-ai.server";
import { readPdfRentRollTable } from "@/lib/portfolio-import/pdf-rent-roll.server";
import { readSpreadsheetTable } from "@/lib/portfolio-import/spreadsheet.server";
import { PortfolioImportUnreadableError } from "@/lib/portfolio-import/errors";
import {
  PORTFOLIO_IMPORT_MAX_BYTES,
  type PortfolioImportDraft,
  type PortfolioImportSourceKind,
  type PortfolioImportSourcePreset,
  type PortfolioImportSourceTable,
} from "@/lib/portfolio-import/types";

/** This manager's current resident emails, so a re-imported roster flags duplicates immediately. */
export async function loadManagerExistingResidentEmails(db: SupabaseClient, managerUserId: string): Promise<string[]> {
  const { data } = await db
    .from("manager_application_records")
    .select("resident_email")
    .eq("manager_user_id", managerUserId)
    .not("resident_email", "is", null);
  return (data ?? [])
    .map((r) => (typeof r.resident_email === "string" ? r.resident_email : ""))
    .filter(Boolean);
}

/**
 * Reads an uploaded file into a `PortfolioImportDraft`. Dispatches pdf vs
 * spreadsheet, applies deterministic header mapping, falls back to the AI
 * header mapper ONLY for the columns the deterministic mapper left unmapped
 * (never row data), then builds the draft against this manager's existing
 * resident emails so a re-imported roster can flag duplicates immediately.
 */
export async function parsePortfolioImportUpload(input: {
  db: SupabaseClient;
  managerUserId: string;
  actor: TraceActor;
  bytes: Uint8Array;
  fileName: string;
  mediaType?: string;
  presetHint?: PortfolioImportSourcePreset;
}): Promise<{
  sourceKind: PortfolioImportSourceKind;
  preset: PortfolioImportSourcePreset;
  table: PortfolioImportSourceTable;
  draft: PortfolioImportDraft;
  aiMappedHeaders: boolean;
}> {
  const { db, managerUserId, actor, bytes, fileName, mediaType, presetHint } = input;
  if (bytes.byteLength > PORTFOLIO_IMPORT_MAX_BYTES) {
    throw new PortfolioImportUnreadableError(
      `That file is too large to import (over ${Math.round(PORTFOLIO_IMPORT_MAX_BYTES / (1024 * 1024))}MB).`,
    );
  }

  const isPdf = (mediaType ?? "").toLowerCase() === "application/pdf" || fileName.toLowerCase().endsWith(".pdf");

  let sourceKind: PortfolioImportSourceKind;
  let table: PortfolioImportSourceTable;
  let preset: PortfolioImportSourcePreset;
  let aiMappedHeaders = false;

  if (isPdf) {
    const pdfResult = await readPdfRentRollTable({ bytes, fileName, actor });
    sourceKind = "pdf";
    preset = "pdf";
    aiMappedHeaders = true;
    // The pdf reader already ran the model to read cells AND infer canonical
    // headers, so its table's headers are canonical keys (or plain text kept
    // as notes) rather than raw source headers — mapPortfolioImportHeaders
    // still runs to build the PortfolioImportColumnMapping[] the draft needs.
    const mapped = mapPortfolioImportHeaders(pdfResult.table.headers, pdfResult.table.rows.slice(0, 5).map((r) => r.cells), "pdf");
    table = pdfResult.table;
    const existingEmails = await loadManagerExistingResidentEmails(db, managerUserId);
    const draft = buildPortfolioImportDraft({
      table,
      columns: mapped.columns,
      sourceKind,
      preset,
      fileName,
      aiMappedHeaders,
      existingEmails,
    });
    return { sourceKind, preset, table, draft, aiMappedHeaders };
  }

  const spreadsheet = readSpreadsheetTable({ bytes, fileName, mediaType });
  sourceKind = spreadsheet.sourceKind;
  table = spreadsheet.table;

  const mapped = mapPortfolioImportHeaders(
    table.headers,
    table.rows.slice(0, 5).map((r) => r.cells),
    presetHint,
  );
  preset = mapped.preset;
  let columns = mapped.columns;

  if (mapped.unmapped.length > 0) {
    const unknownHeaders = mapped.unmapped.map((index) => ({
      index,
      header: table.headers[index] ?? "",
      samples: columns.find((c) => c.index === index)?.samples ?? [],
    }));
    const aiMap = await mapUnknownHeadersWithAi({ headers: unknownHeaders, actor });
    if (Object.keys(aiMap).length > 0) {
      aiMappedHeaders = true;
      for (const [indexStr, key] of Object.entries(aiMap)) {
        columns = applyManualColumnMapping(columns, Number(indexStr), key);
      }
    }
  }

  const existingEmails = await loadManagerExistingResidentEmails(db, managerUserId);

  const draft = buildPortfolioImportDraft({
    table,
    columns,
    sourceKind,
    preset,
    fileName,
    aiMappedHeaders,
    existingEmails,
  });

  return { sourceKind, preset, table, draft, aiMappedHeaders };
}
