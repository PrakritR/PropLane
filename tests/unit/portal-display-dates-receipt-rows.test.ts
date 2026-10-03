import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** STD-6: rent-receipt rows must not show raw ISO in list labels. */
describe("portal list dates — rent receipts", () => {
  it("resident-documents-panel formats receipt meta and detail copy", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/portal/resident-documents-panel.tsx"),
      "utf8",
    );
    expect(source).toContain("formatPortalListDate");
    // The Payments tab appends the amount to the formatted date; the date is never raw ISO.
    expect(source).toMatch(/meta:\s*paymentsTab\s*\?\s*`\$\{formatPortalListDate\(row\.date\)\} · \$\{row\.amount\}`\s*:\s*formatPortalListDate\(row\.date\)/);
  });

  it("documents-download-all-modal formats receipt row labels", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/portal/documents-download-all-modal.tsx"),
      "utf8",
    );
    expect(source).toMatch(/formatPortalListDate\(row\.date\)/);
  });

  it("pro-bills-panel formats due dates in the bills table", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/portal/pro-bills-panel.tsx"),
      "utf8",
    );
    expect(source).toContain("formatPortalListDate");
    expect(source).toMatch(/formatPortalListDate\(bill\.dueDate\)/);
  });

  it("pro-payments-ledger-panel formats due dates in detail cells", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/portal/pro-payments-ledger-panel.tsx"),
      "utf8",
    );
    expect(source).toContain("formatDueMeta");
    expect(source).toMatch(/formatDueMeta\(row\.dueDate/);
  });

  it("pro-resident-overview-panel formats ISO due dates in payment preview facts", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/portal/pro-resident-overview-panel.tsx"),
      "utf8",
    );
    expect(source).toContain("formatPortalListDate");
    expect(source).toMatch(/formatPortalListDate\(row\.dueDate\)/);
  });

  it("outgoing payment detail uses shared due formatting", () => {
    const panel = readFileSync(
      join(process.cwd(), "src/components/portal/pro-outgoing-payments-panel.tsx"),
      "utf8",
    );
    const detail = readFileSync(
      join(process.cwd(), "src/components/portal/pro-outgoing-payment-detail.tsx"),
      "utf8",
    );
    expect(panel).toContain("formatOutgoingDue(");
    expect(panel).toContain("formatOutgoingDueDetail(");
    expect(detail).toMatch(/formatOutgoingDueDetail\(row\.dueDate\)/);
    expect(detail).not.toMatch(/>\{row\.dueDate\}</);
  });
});
