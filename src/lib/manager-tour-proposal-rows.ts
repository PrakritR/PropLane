import { formatRangeLabel } from "@/lib/demo-admin-scheduling";
import type { ManagerTourRow } from "@/lib/manager-tour-list";
import { normalizeTourFormat } from "@/lib/tour-format";

/** The inquiry facts a proposal row needs that the approval preview does not carry. */
export type TourProposalInquirySummary = {
  name: string;
  email: string;
  phone: string;
  propertyId: string;
  propertyTitle: string;
  roomLabel: string;
  tourFormat?: string;
  notes: string;
};

function summaryText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Server shape of the summary (kept here so the route and the row mapper cannot drift). Undefined when there is no inquiry. */
export function tourInquirySummaryForProposal(inquiry: Record<string, unknown> | undefined | null): TourProposalInquirySummary | undefined {
  if (!inquiry) return undefined;
  return {
    name: summaryText(inquiry.name),
    email: summaryText(inquiry.email),
    phone: summaryText(inquiry.phone),
    propertyId: summaryText(inquiry.propertyId),
    propertyTitle: summaryText(inquiry.propertyTitle),
    roomLabel: summaryText(inquiry.roomLabel),
    tourFormat: summaryText(inquiry.tourFormat) || undefined,
    notes: summaryText(inquiry.notes),
  };
}

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
  /** The proposal's own inquiry (contact + house), from the server; absent on older responses. */
  inquiry?: TourProposalInquirySummary;
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
  inquiryLookup?: Pick<ManagerTourRow, "guestName" | "guestEmail" | "guestPhone" | "propertyId" | "propertyTitle" | "roomLabel" | "tourFormat" | "notes"> | null,
): ManagerTourRow | null {
  const startMs = Date.parse(proposal.startIso);
  const endMs = Date.parse(proposal.endIso);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;

  // Each fact: the saved inquiry (the booking form's values) first, then the card's preview field, then the placeholder.
  const saved = proposal.inquiry;
  const guestName = saved?.name || inquiryLookup?.guestName?.trim() || previewField(proposal.preview, "Guest") || "Prospect";
  const propertyTitle = saved?.propertyTitle || inquiryLookup?.propertyTitle?.trim() || previewField(proposal.preview, "Property") || "Property";
  const roomLabel = saved?.roomLabel || inquiryLookup?.roomLabel || previewField(proposal.preview, "Room") || undefined;

  return {
    id: `proposal-${proposal.id}`,
    source: "proposal",
    sourceId: proposal.inquiryId,
    proposalActionId: proposal.id,
    guestName,
    guestEmail: saved?.email || inquiryLookup?.guestEmail?.trim() || "",
    guestPhone: saved?.phone || inquiryLookup?.guestPhone?.trim() || "",
    propertyTitle,
    propertyId: saved?.propertyId || inquiryLookup?.propertyId || undefined,
    roomLabel,
    whenLabel: formatRangeLabel(proposal.startIso, proposal.endIso),
    startIso: proposal.startIso,
    endIso: proposal.endIso,
    startMs,
    endMs,
    statusLabel: "Proposed",
    notes: saved?.notes || inquiryLookup?.notes || undefined,
    tourFormat: normalizeTourFormat(saved?.tourFormat ?? inquiryLookup?.tourFormat),
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
