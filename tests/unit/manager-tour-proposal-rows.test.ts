import { describe, expect, it } from "vitest";
import type { ManagerTourRow } from "@/lib/manager-tour-list";
import {
  managerTourRowFromProposal,
  managerTourRowsFromProposals,
  mergePendingTourRowsWithProposals,
  type TourProposalListItem,
} from "@/lib/manager-tour-proposal-rows";

const PROPOSAL: TourProposalListItem = {
  id: "action-1",
  inquiryId: "inq-1",
  startIso: "2026-09-08T17:00:00.000Z",
  endIso: "2026-09-08T17:30:00.000Z",
  createdAt: "2026-09-08T16:00:00.000Z",
  preview: {
    title: "Confirm tour with Jamie",
    confirmLabel: "Confirm tour",
    fields: [
      { label: "Guest", value: "Jamie Rivera" },
      { label: "Property", value: "Lakeview Studio" },
      { label: "Room", value: "Room 2" },
      { label: "Proposed time", value: "Sep 8, 10:00 AM - 10:30 AM" },
    ],
    warnings: ["Confirming books this time on your calendar and notifies the guest."],
  },
};

function inquiryRow(id: string, sourceId: string): ManagerTourRow {
  return {
    id,
    source: "inquiry",
    sourceId,
    guestName: "Jamie Rivera",
    guestEmail: "jamie@example.com",
    guestPhone: "",
    propertyTitle: "Lakeview Studio",
    propertyId: "prop-1",
    whenLabel: "Sep 8, 9:00 AM - 9:30 AM",
    startIso: "2026-09-08T16:00:00.000Z",
    endIso: "2026-09-08T16:30:00.000Z",
    startMs: Date.parse("2026-09-08T16:00:00.000Z"),
    endMs: Date.parse("2026-09-08T16:30:00.000Z"),
    statusLabel: "Pending",
    tourFormat: "in_person",
    bucket: "pending",
  };
}

describe("manager-tour-proposal-rows", () => {
  it("maps a proposal into a pending tour list row", () => {
    const row = managerTourRowFromProposal(PROPOSAL, inquiryRow("inquiry-inq-1-0", "inq-1"));
    expect(row?.source).toBe("proposal");
    expect(row?.proposalActionId).toBe("action-1");
    expect(row?.guestEmail).toBe("jamie@example.com");
    expect(row?.roomLabel).toBe("Room 2");
    expect(row?.id).toBe("proposal-action-1");
  });

  it("replaces inquiry windows with the single proposal row", () => {
    const proposalRows = managerTourRowsFromProposals([PROPOSAL], [
      inquiryRow("inquiry-inq-1-0", "inq-1"),
      inquiryRow("inquiry-inq-1-1", "inq-1"),
      inquiryRow("inquiry-inq-2-0", "inq-2"),
    ]);
    const merged = mergePendingTourRowsWithProposals(
      [
        inquiryRow("inquiry-inq-1-0", "inq-1"),
        inquiryRow("inquiry-inq-1-1", "inq-1"),
        inquiryRow("inquiry-inq-2-0", "inq-2"),
      ],
      proposalRows,
    );
    expect(merged.filter((row) => row.sourceId === "inq-1")).toHaveLength(1);
    expect(merged.find((row) => row.source === "proposal")?.proposalActionId).toBe("action-1");
    expect(merged.some((row) => row.sourceId === "inq-2")).toBe(true);
  });
});
