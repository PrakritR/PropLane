/**
 * Portfolio import — turns the provenance `create.server.ts` already stamps
 * on an imported resident, property draft, and charge into the one Activity
 * entry the shared record trio renders (`record-section-renderers.tsx`'s
 * `ActivitySection`). Isomorphic and pure: no server-only import, no store
 * read — callers hand in whatever field(s) their record already carries.
 *
 * Each kind's provenance lives in a different existing field, never a new
 * column:
 *  - resident: `DemoApplicantRow.detail` is the free-text sentence
 *    `create.server.ts` writes ("Imported from <file>."); `manualResidentDetails.importedAt`
 *    is the paired ISO date. `parseResidentImportFile` reads the file name back
 *    out of that sentence rather than duplicating it in a second field.
 *  - property draft: `AdminPropertyRow.importFile` / `.importedAt`, additive
 *    fields in the draft's `row_data` (see `create.server.ts`'s `createPropertyDraft`).
 *  - charge: `HouseholdCharge.migrationSourceId` / `.createdAt`, both already
 *    stamped at charge creation — nothing new to add.
 */
import type { RecordSectionActivityEvent } from "@/components/portal/record-section-renderers";

const RESIDENT_IMPORT_DETAIL = /^Imported from (.+)\.$/;

/** Reads the file name back out of the resident's stamped `detail` sentence, or null when the resident was not imported (or the sentence was overwritten by a later manager edit). */
export function parseResidentImportFile(detail: string | null | undefined): string | null {
  if (!detail) return null;
  const match = RESIDENT_IMPORT_DETAIL.exec(detail.trim());
  return match ? match[1]!.trim() : null;
}

function formatImportDate(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime())
    ? ""
    : parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/**
 * One Activity entry: "Imported from <file>" dated to when `create.server.ts`
 * wrote the record. Empty (never a placeholder entry) when either half of the
 * stamp is missing — a record the manager created by hand never shows one.
 */
export function importedActivity(
  file: string | null | undefined,
  importedAt: string | null | undefined,
): RecordSectionActivityEvent[] {
  if (!file || !importedAt) return [];
  return [{ id: "portfolio-import", label: `Imported from ${file}`, timestamp: formatImportDate(importedAt) }];
}
