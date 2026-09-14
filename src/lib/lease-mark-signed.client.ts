/**
 * Browser side of "mark this lease as signed off-platform".
 *
 * One function for both entry points (the lease detail footer and the list's
 * selection bar) so they cannot drift: validate the PDF, ask the server to mark
 * the row executed, pull the row back, then post the charges a signed lease
 * owes. The server owns the decision — see
 * `src/app/api/portal-lease-pipeline/mark-signed/route.ts`.
 */

import { track } from "@/lib/analytics/track-client";
import { recordDelightMoment } from "@/lib/native/app-review";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { recordApprovedApplicationCharges } from "@/lib/household-charges";
import { readLeasePipeline, syncLeasePipelineFromServer, type LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import { normalizeApplicationAxisId, readManagerApplicationRows } from "@/lib/manager-applications-storage";
import { readDataUrlFromFile } from "@/lib/resident-document-import.client";

export const LEASE_PDF_MAX_BYTES = 3.5 * 1024 * 1024;

export type MarkLeaseSignedResult = { ok: true; row: LeasePipelineRow | null } | { ok: false; error: string };

/** The client-side half of the PDF rules; the route re-checks both. */
export function validateSignedLeasePdf(file: File): string | null {
  if (file.type !== "application/pdf") return "Please choose a PDF file.";
  if (file.size > LEASE_PDF_MAX_BYTES) return "PDF too large (max 3.5 MB).";
  return null;
}

export async function markLeaseSignedOffPlatform(
  rowId: string,
  opts: { file?: File | null; signedOn?: string | null; managerUserId: string | null },
): Promise<MarkLeaseSignedResult> {
  if (isDemoModeActive()) {
    return { ok: false, error: "Marking a lease as signed is not available in the demo." };
  }
  const row = readLeasePipeline(opts.managerUserId).find((r) => r.id === rowId) ?? null;
  if (!row) return { ok: false, error: "Lease not found." };

  let pdf: { dataUrl: string; fileName: string } | null = null;
  if (opts.file) {
    const invalid = validateSignedLeasePdf(opts.file);
    if (invalid) return { ok: false, error: invalid };
    try {
      pdf = { dataUrl: await readDataUrlFromFile(opts.file), fileName: opts.file.name };
    } catch {
      return { ok: false, error: "Could not read file." };
    }
  } else {
    // The upload that just happened mirrors to the server asynchronously, so
    // hand the server the bytes this browser holds. Byte-equal to what it
    // already stores is a no-op there; absent there, it is the document.
    const stored = row.managerUploadedPdf?.originalDataUrl || row.managerUploadedPdf?.dataUrl || "";
    if (stored) pdf = { dataUrl: stored, fileName: row.managerUploadedPdf?.fileName || "signed-lease.pdf" };
  }
  if (!pdf) return { ok: false, error: "Attach the signed PDF first." };

  let res: Response;
  try {
    res = await fetch("/api/portal-lease-pipeline/mark-signed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ leaseId: rowId, signedOn: opts.signedOn?.trim() || undefined, pdf }),
    });
  } catch {
    return { ok: false, error: "Could not reach the server. Check your connection and try again." };
  }
  const payload = (await res.json().catch(() => ({}))) as { error?: string; row?: unknown };
  if (!res.ok) return { ok: false, error: payload.error?.trim() || "Could not mark the lease as signed." };

  track("lease_marked_signed", { stage: row.status ?? "unknown", attachedPdf: Boolean(opts.file) });
  recordDelightMoment("lease_signed");

  const serverRows = await syncLeasePipelineFromServer(opts.managerUserId, { force: true }).catch(() => []);
  const marked = serverRows.find((r) => r.id === rowId) ?? null;

  // A signed lease is what makes rent, deposit and move-in charges real —
  // the same moment an e-signed lease bills. Best effort: a charge that does
  // not post here posts on the next Payments materialize.
  try {
    const axisId = (marked ?? row).axisId ? normalizeApplicationAxisId((marked ?? row).axisId) : "";
    const email = (marked ?? row).residentEmail.trim().toLowerCase();
    const app = readManagerApplicationRows().find(
      (a) => (axisId && normalizeApplicationAxisId(a.id) === axisId) || (email && a.email?.trim().toLowerCase() === email),
    );
    if (app) recordApprovedApplicationCharges(app, opts.managerUserId, true, { leaseExecuted: true });
  } catch {
    /* charges reconcile on the next materialize */
  }

  return { ok: true, row: marked };
}
