/**
 * Confirm the manager's comparison of an imported property lease template with the
 * final lease (the "Compare the source and final lease" review). One function for the
 * Leases panel and the Send lease screen so the receipt they persist is identical:
 * bound to the source PDF's SHA-256, the template version and the sanitized final HTML.
 */
import { track } from "@/lib/analytics/track-client";
import { leaseRecordFingerprint } from "@/lib/lease-document-mismatch";
import { sanitizeLeaseDocumentHtml } from "@/lib/lease-document-sanitizer";
import { syncLeasePipelineFromServer, type LeasePipelineRow } from "@/lib/lease-pipeline-storage";

async function reviewHtmlSha256(html: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Secure review hashing is unavailable.");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(html));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** True while this lease still needs the manager to compare the template with the final lease. */
export function leaseNeedsTemplatePlacementReview(row: LeasePipelineRow): boolean {
  return Boolean(row.templateImportReview && !row.templatePlacementReview?.riderConflictAcknowledged);
}

export async function confirmTemplatePlacementReviewForRow(
  row: LeasePipelineRow,
  managerUserId: string | null,
): Promise<{ ok: true; row: LeasePipelineRow | null } | { ok: false; error: string }> {
  let finalHtmlSha256: string;
  try {
    finalHtmlSha256 = await reviewHtmlSha256(sanitizeLeaseDocumentHtml(row.generatedHtml ?? "") ?? "");
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not save the lease review." };
  }
  const response = await fetch("/api/portal-lease-pipeline", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      action: "confirm_template_placement_review",
      leaseId: row.id,
      acknowledgeTermsRiderConflicts: true,
      expectedReview: {
        revision: row.reviewRevision,
        sourceSha256: row.templateImportReview?.sourceSha256,
        finalHtmlSha256,
        recordFingerprint: leaseRecordFingerprint({
          residentName: row.residentName,
          leaseStart: row.application?.leaseStart ?? null,
          leaseEnd: row.application?.leaseEnd ?? null,
          rentLabel: row.signedRentLabel ?? null,
        }),
      },
    }),
  });
  const result = (await response.json().catch(() => ({}))) as { error?: unknown };
  if (!response.ok) {
    track("lease_import_failed", { lease_id: row.id, import_kind: "property_template_placement", reason_code: "review_save_failed" });
    return { ok: false, error: typeof result.error === "string" ? result.error : "Could not save the lease review." };
  }
  track("lease_import_reviewed", { lease_id: row.id, import_kind: "property_template_placement", artifact_mode: "converted" });
  const updated = await syncLeasePipelineFromServer(managerUserId, { force: true });
  return { ok: true, row: updated.find((candidate) => candidate.id === row.id) ?? null };
}
