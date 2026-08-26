import {
  reinsertMissingDisclosureParagraphs,
  sanitizeManagerLeaseDocumentEdit,
} from "@/lib/lease-document-sanitizer";
import {
  applyLeaseSectionBodyEdits,
  parseLeaseHtmlSections,
  type LeaseHtmlSection,
} from "@/lib/lease-html-sections";
import { isEditableLeaseSection, type LeaseSectionEdit } from "@/lib/lease-section-text";
import {
  getLeaseDocumentHtml,
  leaseAllowsManagerDocumentEdits,
  readLeasePipeline,
  updateLeasePipelineRow,
  type LeasePipelineRow,
} from "@/lib/lease-pipeline-storage";

/**
 * A manager edits a section one of two ways, and exactly one of them is authoritative
 * for any given section at any time:
 *
 * - TEXT / RICH (the default) writes `managerSectionEdits[id]`, which `getLeaseDocumentHtml`
 *   renders over the stored body. Manager prose cannot express markup — see
 *   `lease-section-text.ts`.
 * - HTML writes the section body straight into `generatedHtml`.
 *
 * The tiebreaker is structural rather than a rule to remember: every HTML persist is
 * BASED ON the rendered document and clears `managerSectionEdits`. The overrides are
 * baked into the bytes being saved, so nothing is lost, and no leftover override can
 * later win over the HTML a manager just wrote.
 */
export function leaseDocumentHtmlForSectionEdit(row: LeasePipelineRow): string | null {
  if (row.managerUploadedPdf?.dataUrl || row.templateDocumentUrl) return null;
  // The RENDERED document, not the raw stored body: an editor that showed the raw body
  // would present stale text for any section already edited as prose.
  return getLeaseDocumentHtml(row)?.trim() || null;
}

export function readLeaseSectionsForEdit(row: LeasePipelineRow): LeaseHtmlSection[] {
  const html = leaseDocumentHtmlForSectionEdit(row);
  return html ? parseLeaseHtmlSections(html) : [];
}

/** Text / rich mode: store the manager's words, render them at read time. */
export function saveLeaseSectionEdits(
  leaseId: string,
  edits: Readonly<Record<string, LeaseSectionEdit>>,
  managerUserId?: string | null,
): { ok: true; row: LeasePipelineRow } | { ok: false; error: string } {
  const row = readLeasePipeline(managerUserId).find((candidate) => candidate.id === leaseId);
  if (!row) return { ok: false, error: "Lease not found." };
  if (!leaseAllowsManagerDocumentEdits(row)) return { ok: false, error: "This lease can no longer be edited." };

  const sections = readLeaseSectionsForEdit(row);
  if (!sections.length) return { ok: false, error: "No lease sections are available to edit." };
  const validEdits = Object.fromEntries(
    Object.entries(edits).filter(([sectionId, edit]) => {
      const section = sections.find((candidate) => candidate.id === sectionId);
      return Boolean(section && isEditableLeaseSection(section) && (edit.format === "text" || edit.format === "rich"));
    }),
  );
  if (!Object.keys(validEdits).length) return { ok: false, error: "Choose an editable lease section." };

  const saved = updateLeasePipelineRow(
    leaseId,
    { managerSectionEdits: { ...(row.managerSectionEdits ?? {}), ...validEdits } },
    managerUserId,
  );
  if (!saved) return { ok: false, error: "Could not save section edits." };
  const updated = readLeasePipeline(managerUserId).find((candidate) => candidate.id === leaseId);
  return updated ? { ok: true, row: updated } : { ok: false, error: "Saved but could not reload the lease." };
}

/** HTML mode: write the section's markup into the document body itself. */
export function saveLeaseSectionBodyEdits(
  leaseId: string,
  sectionEdits: Readonly<Record<string, string>>,
  managerUserId?: string | null,
): { ok: true; row: LeasePipelineRow } | { ok: false; error: string } {
  const row = readLeasePipeline(managerUserId).find((r) => r.id === leaseId);
  if (!row) return { ok: false, error: "Lease not found." };
  if (!leaseAllowsManagerDocumentEdits(row)) {
    return { ok: false, error: "This lease can no longer be edited." };
  }
  const baseHtml = leaseDocumentHtmlForSectionEdit(row);
  if (!baseHtml) {
    return { ok: false, error: "Upload a PDF lease or generate HTML before editing sections." };
  }
  if (!Object.keys(sectionEdits).length) {
    return { ok: false, error: "No section changes to save." };
  }

  const nextHtml = applyLeaseSectionBodyEdits(baseHtml, sectionEdits);
  return persistLeaseDocumentHtml(leaseId, nextHtml, managerUserId);
}

function persistLeaseDocumentHtml(
  leaseId: string,
  nextHtml: string,
  managerUserId?: string | null,
): { ok: true; row: LeasePipelineRow } | { ok: false; error: string } {
  const row = readLeasePipeline(managerUserId).find((r) => r.id === leaseId);
  if (!row) return { ok: false, error: "Lease not found." };
  if (!leaseAllowsManagerDocumentEdits(row)) {
    return { ok: false, error: "This lease can no longer be edited." };
  }
  const baseHtml = leaseDocumentHtmlForSectionEdit(row);
  if (!baseHtml) {
    return { ok: false, error: "Upload a PDF lease or generate HTML before editing." };
  }
  if (nextHtml.trim() === baseHtml.trim()) {
    return { ok: false, error: "No document changes to save." };
  }

  const mergedHtml = reinsertMissingDisclosureParagraphs(baseHtml, nextHtml);
  const sanitized = sanitizeManagerLeaseDocumentEdit(baseHtml, mergedHtml);
  if (!sanitized.ok) {
    return { ok: false, error: sanitized.error };
  }

  const iso = new Date().toISOString();
  const version = (row.versionNumber ?? row.pdfVersion ?? 0) + 1;
  const saved = updateLeasePipelineRow(
    leaseId,
    {
      generatedHtml: sanitized.html,
      // `nextHtml` was built from the RENDERED document, so every typed override is
      // already baked into these bytes. Keeping the map would re-apply them over the
      // manager's HTML on the next read, silently discarding this edit.
      managerSectionEdits: null,
      generatedAtIso: iso,
      pdfVersion: version,
      versionNumber: version,
      managerUploadedPdf: null,
      status: "Manager Review",
      currentActorRole: "manager",
      bucket: "manager",
    },
    managerUserId,
  );
  if (!saved) return { ok: false, error: "Could not save document edits." };
  const updated = readLeasePipeline(managerUserId).find((r) => r.id === leaseId);
  return updated ? { ok: true, row: updated } : { ok: false, error: "Saved but could not reload the lease." };
}

/** Save the full generated HTML after visual or multi-section editing. */
export function saveLeaseDocumentHtml(
  leaseId: string,
  documentHtml: string,
  managerUserId?: string | null,
): { ok: true; row: LeasePipelineRow } | { ok: false; error: string } {
  return persistLeaseDocumentHtml(leaseId, documentHtml, managerUserId);
}
