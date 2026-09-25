/**
 * Browser side of "upload a lease, then read it into PropLane format".
 *
 * One function so both upload surfaces (the resident detail Lease tab and the
 * Leases pipeline) behave identically: store the PDF, structure it, store the
 * structure. The lease is held in review the whole time — `managerUploadLeasePdf`
 * writes the `pending` parse synchronously, so even a network failure here
 * leaves the lease unsignable rather than quietly signable.
 */

import { isDemoModeActive } from "@/lib/demo/demo-session";
import { track } from "@/lib/analytics/track-client";
import {
  managerUploadLeasePdf,
  readLeasePipeline,
  saveUploadedLeaseParse,
} from "@/lib/lease-pipeline-storage";
import {
  failedUploadedLeaseParse,
  normalizeUploadedLeaseParse,
  type UploadedLeaseParse,
} from "@/lib/uploaded-lease-extraction";

export async function parseUploadedLeaseDataUrl(args: {
  dataUrl: string;
  fileName: string;
}): Promise<UploadedLeaseParse> {
  const res = await fetch("/api/portal/parse-uploaded-lease", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ dataUrl: args.dataUrl, fileName: args.fileName }),
  });
  const payload = (await res.json().catch(() => ({}))) as { parse?: unknown; error?: string };
  if (!res.ok) throw new Error(payload.error ?? "Could not read that lease PDF.");
  const parse = normalizeUploadedLeaseParse(payload.parse);
  if (!parse) throw new Error("Could not read that lease PDF.");
  return parse;
}

export type UploadAndParseResult = {
  ok: boolean;
  error?: string;
  /** Null in demo mode, where no parse round trip runs. */
  parse?: UploadedLeaseParse | null;
  /**
   * The PDF landed but its reading did not: the row already carries a confirmed
   * review, or the upload went missing under us. The returned `parse` is then
   * NOT what the row holds, so a caller must say so rather than report the
   * import as stored.
   */
  saveError?: string;
};

/**
 * Upload the PDF onto a lease row and structure it in one step.
 *
 * A failed parse is RECORDED as a failed parse rather than dropped: the row
 * keeps its unconfirmed state (so signing stays blocked) and the manager sees
 * why, instead of a lease that silently looks ready.
 */
export async function uploadAndParseLeasePdf(
  rowId: string,
  file: File,
  managerUserId?: string | null,
): Promise<UploadAndParseResult> {
  track("lease_import_started", { lease_id: rowId, import_kind: "uploaded_pdf" });
  const uploaded = await managerUploadLeasePdf(rowId, file, managerUserId);
  if (!uploaded.ok) {
    track("lease_import_failed", { lease_id: rowId, reason_code: "upload_failed" });
    return { ok: false, error: uploaded.error };
  }
  if (isDemoModeActive()) return { ok: true, parse: null };

  const row = readLeasePipeline(managerUserId).find((r) => r.id === rowId);
  const dataUrl = row?.managerUploadedPdf?.originalDataUrl ?? row?.managerUploadedPdf?.dataUrl ?? "";
  if (!dataUrl) {
    track("lease_import_failed", { lease_id: rowId, reason_code: "source_missing" });
    return { ok: true, parse: null };
  }

  let parse: UploadedLeaseParse;
  try {
    parse = await parseUploadedLeaseDataUrl({ dataUrl, fileName: file.name });
  } catch (err) {
    parse = failedUploadedLeaseParse(file.name, err instanceof Error ? err.message : "Could not read that lease PDF.");
  }
  if (parse.status === "failed") track("lease_import_failed", { lease_id: rowId, reason_code: "parse_failed" });
  const saved = saveUploadedLeaseParse(rowId, parse, managerUserId);
  if (!saved.ok) {
    track("lease_import_failed", { lease_id: rowId, reason_code: "reading_store_failed" });
    return { ok: true, saveError: saved.error ?? "The imported reading could not be stored." };
  }
  return { ok: true, parse };
}

/**
 * Read an already-uploaded lease again, from the bytes the row already holds.
 *
 * Without this, `pending` is a terminal state: the parse is written
 * synchronously at upload time, so a manager who closes the tab mid-read leaves
 * a row that can never be sent and offers no way forward but deleting the lease.
 * Retry re-reads `originalDataUrl` — the PDF is never re-uploaded, replaced, or
 * touched — and stores the result through the same `saveUploadedLeaseParse`.
 *
 * It never confirms anything: the fresh parse lands `needs_review`, so the
 * human step the gate exists for is still required.
 */
export async function retryUploadedLeaseParse(
  rowId: string,
  managerUserId?: string | null,
): Promise<{ ok: boolean; error?: string; parse?: UploadedLeaseParse }> {
  if (isDemoModeActive()) return { ok: false, error: "Reading an uploaded lease is disabled in the demo." };
  track("lease_import_started", { lease_id: rowId, import_kind: "retry_read" });
  const row = readLeasePipeline(managerUserId).find((r) => r.id === rowId);
  const upload = row?.managerUploadedPdf;
  const dataUrl = upload?.originalDataUrl ?? upload?.dataUrl ?? "";
  if (!dataUrl) return { ok: false, error: "No uploaded lease document on this record." };

  let parse: UploadedLeaseParse;
  try {
    parse = await parseUploadedLeaseDataUrl({
      dataUrl,
      fileName: upload?.fileName || row?.uploadedLeaseParse?.sourceFileName || "Uploaded lease.pdf",
    });
  } catch (err) {
    parse = failedUploadedLeaseParse(
      upload?.fileName || "Uploaded lease.pdf",
      err instanceof Error ? err.message : "Could not read that lease PDF.",
    );
  }
  if (parse.status === "failed") track("lease_import_failed", { lease_id: rowId, reason_code: "parse_failed" });
  const saved = saveUploadedLeaseParse(rowId, parse, managerUserId);
  if (!saved.ok) return { ok: false, error: saved.error ?? "The imported reading could not be stored." };
  return { ok: true, parse };
}
