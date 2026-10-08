import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PANEL = readFileSync(
  join(process.cwd(), "src/components/portal/pro-applications.tsx"),
  "utf8",
);

describe("applications list bulk bar mirrors detail footer actions", () => {
  it("shows contextual actions only when selection applies (no always-disabled buttons)", () => {
    expect(PANEL).toContain("selectedListRows.length > 0 ? (");
    expect(PANEL).not.toContain('disabled={!canBulkApprove}');
    expect(PANEL).not.toContain('disabled={!canBulkReject}');
  });

  // The row ⋯ is Approve · Remind · Download · (Move to pending) · Decline · (Delete). Incomplete and
  // Withdrawn are facts on a Pending row, not tabs, so Remind is keyed on the row, not on a tab.
  it("exposes Remind for incomplete and in-progress rows", () => {
    expect(PANEL).toContain('data-attr="applications-bulk-send-reminder"');
    expect(PANEL).not.toContain('bucket === "incomplete"');
    expect(PANEL).toContain("canBulkSendReminder");
  });

  it("exposes download, move-to-pending and Decline for single-row selections; the record header carries no Share", () => {
    expect(PANEL).toContain('data-attr="applications-bulk-move-pending"');
    expect(PANEL).toContain('data-attr="applications-bulk-decline"');
    expect(PANEL).toContain("ApplicationPdfDownloadButton");
    expect(PANEL).toContain("applicationRowCanMoveToPending");
    expect(PANEL).not.toContain('dataAttr="applications-bulk-share"');
    expect(PANEL).not.toContain('application-share');
  });

  it("declines in one click (no confirm dialog) with an Undo", () => {
    expect(PANEL).toContain("declineApplicationWithUndo");
    expect(PANEL).not.toContain("application-reject-confirm");
  });

  it("opens the one Approve popup from every entry point", () => {
    expect(PANEL).toContain("ApproveApplicationDialog");
    expect(PANEL).not.toContain("application-resident-slot-modal");
  });

  it("allows approve and move-to-pending on rejected applications", () => {
    expect(PANEL).toContain('row.bucket === "rejected"');
    expect(PANEL).toContain("selectedApprovableRows");
    expect(PANEL).toContain("isApprovableApplicationRow");
  });

  it("puts holding fee on the detail body when the listing offers one", () => {
    expect(PANEL).toContain("ApplicationHoldingFeeToggle");
    expect(PANEL).toContain('row.bucket !== "rejected"');
    expect(PANEL).toContain("!isWithdrawnApplicationRow(row)");
  });

  it("keeps delete on any selection", () => {
    expect(PANEL).toContain('data-attr="applications-bulk-delete"');
    expect(PANEL).toContain("canBulkDelete");
  });
});
