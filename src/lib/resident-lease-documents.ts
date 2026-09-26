import type { LeasePipelineRow, SignedLeaseSnapshot } from "@/lib/lease-pipeline-storage";
import { hasBothLeaseSignatures, residentCanViewLeaseRow } from "@/lib/lease-pipeline-storage";

export type ResidentLeaseDocumentFilterBucket = "pending" | "signed";

export type ResidentLeaseStatusFilter = "all" | ResidentLeaseDocumentFilterBucket;

export type ResidentLeaseDocumentRow = {
  id: string;
  leaseRowId: string;
  label: string;
  status: string;
  signedAt: string;
  filterBucket: ResidentLeaseDocumentFilterBucket;
  snapshot: SignedLeaseSnapshot | null;
  pipelineRow: LeasePipelineRow | null;
};

export function residentLeaseStatusFilterTabs(
  rows: ResidentLeaseDocumentRow[],
): { id: ResidentLeaseStatusFilter; label: string; count: number }[] {
  const pending = rows.filter((row) => row.filterBucket === "pending").length;
  const signed = rows.filter((row) => row.filterBucket === "signed").length;
  return [
    { id: "all", label: "All", count: rows.length },
    { id: "pending", label: "Pending", count: pending },
    { id: "signed", label: "Signed", count: signed },
  ];
}

export function filterResidentLeaseDocumentRows(
  rows: ResidentLeaseDocumentRow[],
  filter: ResidentLeaseStatusFilter,
): ResidentLeaseDocumentRow[] {
  if (filter === "all") return rows;
  return rows.filter((row) => row.filterBucket === filter);
}

export function encodeLeaseDocumentDetailId(leaseRowId: string, snapshotId?: string | null): string {
  if (!snapshotId) return leaseRowId;
  return `${leaseRowId}--${snapshotId}`;
}

export function decodeLeaseDocumentDetailId(detailId: string): { leaseRowId: string; snapshotId: string | null } {
  const sep = detailId.indexOf("--");
  if (sep === -1) return { leaseRowId: detailId, snapshotId: null };
  return { leaseRowId: detailId.slice(0, sep), snapshotId: detailId.slice(sep + 2) || null };
}

export function buildResidentLeaseDocumentRows(row: LeasePipelineRow | null): ResidentLeaseDocumentRow[] {
  if (!row) return [];

  const rows: ResidentLeaseDocumentRow[] = [];
  for (const snapshot of row.signedLeaseSnapshots ?? []) {
    rows.push({
      id: encodeLeaseDocumentDetailId(row.id, snapshot.id),
      leaseRowId: row.id,
      label: snapshot.label,
      status: "Signed",
      signedAt: snapshot.fullySignedAt,
      filterBucket: "signed",
      snapshot,
      pipelineRow: null,
    });
  }

  // A lease-first draft (Part 3 hotfix, defect 4) has no document yet — the
  // manager hasn't generated or sent it — so `residentCanViewLeaseRow` is
  // correctly false. It still needs to appear so the resident can open it and
  // fill in the intake section (`ResidentLeaseIntakeSection`); marked with
  // `leaseFirst: true` by `createLeaseFirstDraft` so an ordinary draft the
  // manager has not shared yet stays invisible.
  const isLeaseFirstDraft = row.leaseFirst === true && row.bucket === "manager" && row.status === "Draft";

  if (hasBothLeaseSignatures(row)) {
    rows.unshift({
      id: encodeLeaseDocumentDetailId(row.id),
      leaseRowId: row.id,
      label: `Current lease${row.unit ? ` · ${row.unit}` : ""}`,
      status: "Signed",
      signedAt: row.fullySignedAt ?? row.updatedAtIso,
      filterBucket: "signed",
      snapshot: null,
      pipelineRow: row,
    });
  } else if (
    residentCanViewLeaseRow(row) ||
    row.pendingRenewal ||
    isLeaseFirstDraft ||
    ((row.signedLeaseSnapshots?.length ?? 0) > 0 && Boolean(row.generatedHtml || row.managerUploadedPdf?.dataUrl))
  ) {
    rows.unshift({
      id: encodeLeaseDocumentDetailId(row.id),
      leaseRowId: row.id,
      label: row.pendingRenewal
        ? `Renewal in progress${row.unit ? ` · ${row.unit}` : ""}`
        : isLeaseFirstDraft
          ? `Your lease details${row.unit ? ` · ${row.unit}` : ""}`
          : `Lease agreement${row.unit ? ` · ${row.unit}` : ""}`,
      status: isLeaseFirstDraft ? "Details needed" : "Pending",
      signedAt: row.updatedAtIso,
      filterBucket: "pending",
      snapshot: null,
      pipelineRow: row,
    });
  }

  return rows;
}

export function resolveResidentLeaseDocumentView(
  row: LeasePipelineRow | null,
  detailId: string,
): {
  title: string;
  subtitle: string;
  pdfSrc: string | null;
  leaseHtml: string | null;
  pipelineRow: LeasePipelineRow | null;
} | null {
  if (!row) return null;
  const { leaseRowId, snapshotId } = decodeLeaseDocumentDetailId(detailId);
  if (leaseRowId !== row.id) return null;

  if (snapshotId) {
    const snapshot = (row.signedLeaseSnapshots ?? []).find((entry) => entry.id === snapshotId);
    if (!snapshot) return null;
    return {
      title: snapshot.label,
      subtitle: `Signed · ${snapshot.fullySignedAt}`,
      pdfSrc: snapshot.managerUploadedPdf?.dataUrl ?? null,
      leaseHtml: snapshot.generatedHtml ?? null,
      pipelineRow: null,
    };
  }

  const pdfSrc = row.managerUploadedPdf?.dataUrl ?? null;
  const leaseHtml = pdfSrc ? null : row.generatedHtml ?? null;
  const signedAt = row.fullySignedAt ?? row.updatedAtIso;
  const title = hasBothLeaseSignatures(row)
    ? `Current lease${row.unit ? ` · ${row.unit}` : ""}`
    : row.pendingRenewal
      ? `Renewal in progress${row.unit ? ` · ${row.unit}` : ""}`
      : `Lease agreement${row.unit ? ` · ${row.unit}` : ""}`;
  return {
    title,
    subtitle: hasBothLeaseSignatures(row) ? `Fully signed · ${signedAt}` : row.status ?? "Pending signatures",
    pdfSrc,
    leaseHtml,
    pipelineRow: row,
  };
}
