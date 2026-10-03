import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PANEL = readFileSync(join(process.cwd(), "src/components/portal/pro-leases-pipeline-panel.tsx"), "utf8");
const HEADER = readFileSync(join(process.cwd(), "src/components/portal/lease-primary-header-actions.tsx"), "utf8");

// The lease row ⋯ is five actions — View · Send · Download · Mark as signed · Delete — and Send opens the one
// Send lease screen. Everything else a lease can do (remind, countersign, new terms, export, share, review the
// import…) is on the record's header, which is the single publisher of those icons.
describe("leases list ⋯ is five actions; the record header carries the rest", () => {
  it("the row ⋯ offers Send, Download, Mark as signed and Delete (View is added by opening the row)", () => {
    for (const attr of ["leases-bulk-send", "leases-bulk-download", "leases-bulk-mark-signed", "leases-bulk-delete"]) {
      expect(PANEL).toContain(`data-attr="${attr}"`);
    }
    expect(PANEL).toContain("leaseCanBeSentFromList");
  });

  it("no longer crowds the ⋯ with the record's actions", () => {
    for (const attr of ["leases-bulk-move-review", "leases-bulk-signing-reminder", "leases-bulk-sign", "leases-bulk-new-terms", "leases-bulk-review-import", "leases-bulk-upload", "leases-bulk-export"]) {
      expect(PANEL).not.toContain(`data-attr="${attr}"`);
    }
  });

  it("Send opens the one Send lease screen", () => {
    expect(PANEL).toContain("LeaseSendSheet");
    expect(PANEL).toContain("setSendSheetLeaseId(row.id)");
  });

  it("the record header carries remind, sign, new terms, review import, upload, move to review and mark as signed", () => {
    for (const needle of ["signingReminderDataAttr", "signManagerDataAttr", 'id: "new-terms"', 'id: "review-import"', 'id: "upload"', 'id: "move-review"', 'id: "mark-signed"']) {
      expect(HEADER).toContain(needle);
    }
    expect(PANEL).toContain("setAmendLeaseRow(row)");
    expect(PANEL).toContain("<LeasePrimaryHeaderActions");
  });
});
