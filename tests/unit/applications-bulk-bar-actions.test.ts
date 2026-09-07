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

  it("exposes send reminder for incomplete and in-progress selections", () => {
    expect(PANEL).toContain('data-attr="applications-bulk-send-reminder"');
    expect(PANEL).toContain('bucket === "incomplete"');
    expect(PANEL).toContain("canBulkSendReminder");
  });

  it("exposes share, download, and move-to-pending for single-row selections", () => {
    expect(PANEL).toContain('dataAttr="applications-bulk-share"');
    expect(PANEL).toContain('data-attr="applications-bulk-move-pending"');
    expect(PANEL).toContain("ApplicationPdfDownloadButton");
    expect(PANEL).toContain("applicationRowCanMoveToPending");
  });

  it("allows approve and move-to-pending on rejected applications", () => {
    expect(PANEL).toContain('row.bucket === "rejected"');
    expect(PANEL).toContain("selectedApprovableRows");
    expect(PANEL).toContain("isApprovableApplicationRow");
  });

  it("aligns holding fee with detail (non-rejected, non-withdrawn)", () => {
    expect(PANEL).toContain('singleListSelectedRow.bucket !== "rejected"');
    expect(PANEL).toContain("!isWithdrawnApplicationRow(singleListSelectedRow)");
  });

  it("keeps delete on any selection", () => {
    expect(PANEL).toContain('data-attr="applications-bulk-delete"');
    expect(PANEL).toContain("canBulkDelete");
  });
});
