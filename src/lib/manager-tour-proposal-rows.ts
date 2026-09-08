import { formatRangeLabel } from "@/lib/demo-admin-scheduling";
import type { ManagerTourRow } from "@/lib/manager-tour-list";
import { normalizeTourFormat } from "@/lib/tour-format";

export type TourProposalListItem = {
  id: string;
  inquiryId: string;
  startIso: string;
  endIso: string;
  preview: {
    title: string;
    confirmLabel?: string;
    fields: { label: string; value: string }[];
    warnings?: string[];
  };
  createdAt: string;
};

function previewField(
  preview: TourProposalListItem["preview"],
  label: string,
): string {
  return preview.fields.find((field) => field.label === label)?.value?.trim() ?? "";
}

/** Map an open tour proposal into the same row shape the Tours list already uses. */
export function managerTourRowFromProposal(
  proposal: TourProposalListItem,
  inquiryLookup?: Pick<ManagerTourRow, "guestEmail" | "guestPhone" | "propertyId"> | null,
): ManagerTourRow | null {
  const startMs = Date.parse(proposal.startIso);
  const endMs = Date.parse(proposal.endIso);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;

  const guestName = previewField(proposal.preview, "Guest") || "Prospect";
  const propertyTitle = previewField(proposal.preview, "Property") || "Property";
  const roomLabel = previewField(proposal.preview, "Room") || undefined;

  return {
    id: `proposal-${proposal.id}`,
    source: "proposal",
    sourceId: proposal.inquiryId,
    proposalActionId: proposal.id,
    guestName,
    guestEmail: inquiryLookup?.guestEmail?.trim() ?? "",
    guestPhone: inquiryLookup?.guestPhone?.trim() ?? "",
    propertyTitle,
    propertyId: inquiryLookup?.propertyId,
    roomLabel,
    whenLabel: formatRangeLabel(proposal.startIso, proposal.endIso),
    startIso: proposal.startIso,
    endIso: proposal.endIso,
    startMs,
    endMs,
    statusLabel: "Proposed",
    tourFormat: normalizeTourFormat(undefined),
    bucket: "pending",
  };
}

export function managerTourRowsFromProposals(
  proposals: TourProposalListItem[],
  inquiryRows: readonly ManagerTourRow[],
): ManagerTourRow[] {
  const inquiryById = new Map<string, ManagerTourRow>();
  for (const row of inquiryRows) {
    if (row.source === "inquiry" && row.sourceId) inquiryById.set(row.sourceId, row);
  }
  return proposals
    .map((proposal) => managerTourRowFromProposal(proposal, inquiryById.get(proposal.inquiryId) ?? null))
    .filter((row): row is ManagerTourRow => Boolean(row));
}

/** When a proposal exists, hide the raw inquiry windows so the manager sees one row. */
export function mergePendingTourRowsWithProposals(
  inquiryAndPlannedRows: ManagerTourRow[],
  proposalRows: ManagerTourRow[],
): ManagerTourRow[] {
  if (proposalRows.length === 0) return inquiryAndPlannedRows;
  const coveredInquiryIds = new Set(
    proposalRows.filter((row) => row.source === "proposal").map((row) => row.sourceId),
  );
  const base = inquiryAndPlannedRows.filter(
    (row) => row.source !== "inquiry" || !coveredInquiryIds.has(row.sourceId),
  );
  return [...proposalRows, ...base];
}
