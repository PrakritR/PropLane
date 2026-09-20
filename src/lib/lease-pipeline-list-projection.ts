/**
 * Lease list responses must not carry PDF/HTML document bytes. One imported
 * signed PDF is already multiple megabytes; a manager pipeline of those blows
 * the Residents + Leases GET past Vercel/browser limits and the directory
 * fails closed with "Could not load residents".
 *
 * The list keeps filenames and an `documentOmitted` flag. Detail
 * `GET /api/portal-lease-pipeline?id=` returns the stored bytes. A list-shaped
 * write must never replace those stored bytes.
 */

export type LeaseListPdfMeta = {
  dataUrl?: string | null;
  fileName?: string | null;
  uploadedAt?: string | null;
  originalDataUrl?: string | null;
  omitted?: boolean;
  libraryDocumentId?: string | null;
};

export type LeaseListDocumentRow = {
  id?: string;
  generatedHtml?: string | null;
  documentOmitted?: boolean;
  managerUploadedPdf?: LeaseListPdfMeta | null;
  signedLeaseSnapshots?: LeaseListDocumentRow[] | null;
  leaseDocumentRemovedAt?: string | null;
};

function isEmbeddedDocument(value: string | null | undefined): boolean {
  const text = value?.trim() ?? "";
  return text.startsWith("data:") || text.length > 4000;
}

export function leaseRowCarriesDocumentBytes(row: LeaseListDocumentRow | null | undefined): boolean {
  if (!row) return false;
  return Boolean(
    isEmbeddedDocument(row.generatedHtml) ||
      isEmbeddedDocument(row.managerUploadedPdf?.dataUrl) ||
      isEmbeddedDocument(row.managerUploadedPdf?.originalDataUrl),
  );
}

export function leaseListRowOmitsDocument(row: LeaseListDocumentRow | null | undefined): boolean {
  if (!row) return false;
  if (row.documentOmitted === true || row.managerUploadedPdf?.omitted === true) return true;
  const pdf = row.managerUploadedPdf;
  return Boolean(pdf?.fileName?.trim()) && !leaseRowCarriesDocumentBytes(row);
}

export function leaseRowHasDocument(row: LeaseListDocumentRow | null | undefined): boolean {
  if (!row || row.leaseDocumentRemovedAt) return false;
  return leaseRowCarriesDocumentBytes(row) || leaseListRowOmitsDocument(row);
}

function projectPdf(pdf: LeaseListPdfMeta | null | undefined): LeaseListPdfMeta | null {
  if (!pdf) return null;
  return {
    fileName: pdf.fileName ?? "Uploaded lease.pdf",
    uploadedAt: pdf.uploadedAt ?? "",
    dataUrl: "",
    omitted: true,
    ...(pdf.libraryDocumentId ? { libraryDocumentId: pdf.libraryDocumentId } : {}),
  };
}

export function projectLeasePipelineListRow<T extends LeaseListDocumentRow>(row: T): T {
  const hadBytes = leaseRowCarriesDocumentBytes(row);
  const omitted = hadBytes || leaseListRowOmitsDocument(row);
  const snapshots = Array.isArray(row.signedLeaseSnapshots)
    ? row.signedLeaseSnapshots.map((snap) => projectLeasePipelineListRow(snap))
    : row.signedLeaseSnapshots;
  return {
    ...row,
    generatedHtml: omitted && row.generatedHtml ? "" : row.generatedHtml,
    documentOmitted: omitted,
    managerUploadedPdf: projectPdf(row.managerUploadedPdf),
    signedLeaseSnapshots: snapshots,
  };
}

export function restoreOmittedLeaseDocument<T extends LeaseListDocumentRow>(stored: T | undefined, incoming: T): T {
  if (!stored || !leaseListRowOmitsDocument(incoming) || !leaseRowCarriesDocumentBytes(stored)) {
    return incoming;
  }
  return {
    ...incoming,
    generatedHtml: stored.generatedHtml ?? incoming.generatedHtml,
    managerUploadedPdf: stored.managerUploadedPdf ?? incoming.managerUploadedPdf,
    signedLeaseSnapshots: stored.signedLeaseSnapshots ?? incoming.signedLeaseSnapshots,
    documentOmitted: false,
  };
}

export function mergeOmittedLeaseDocuments<T extends LeaseListDocumentRow & { id: string }>(
  prev: T[],
  next: T[],
): T[] {
  const prevById = new Map(prev.map((row) => [row.id, row]));
  return next.map((row) => restoreOmittedLeaseDocument(prevById.get(row.id), row));
}
