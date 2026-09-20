import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hasBothLeaseSignatures, type LeasePipelineRow } from "@/lib/lease-pipeline-storage";

const header = readFileSync(
  join(process.cwd(), "src/components/portal/lease-primary-header-actions.tsx"),
  "utf8",
);
const panel = readFileSync(join(process.cwd(), "src/components/portal/pro-leases-pipeline-panel.tsx"), "utf8");
const modal = readFileSync(join(process.cwd(), "src/components/portal/lease-amend-move-out-modal.tsx"), "utf8");

function signedOffPlatformRow(): LeasePipelineRow {
  return {
    id: "lease-1",
    axisId: "AXIS-1",
    residentName: "Aaron Armbrister",
    residentEmail: "aaron@example.com",
    propertyId: "prop-1",
    status: "Fully Signed",
    bucket: "signed",
    externallySignedLease: true,
    managerSignature: { role: "manager", name: "Manager", signedAtIso: "2026-01-01T00:00:00.000Z" },
    residentSignature: { role: "resident", name: "Aaron Armbrister", signedAtIso: "2026-01-01T00:00:00.000Z" },
    managerUploadedPdf: { dataUrl: "data:application/pdf;base64,AAA", fileName: "lease.pdf" },
  } as LeasePipelineRow;
}

describe("New terms on off-platform signed leases", () => {
  it("treats mark-signed synthetic signatures as fully signed", () => {
    expect(hasBothLeaseSignatures(signedOffPlatformRow())).toBe(true);
  });

  it("shows one New terms icon, not Renew + Extend", () => {
    expect(header).toContain('label="New terms"');
    expect(header).toContain('dataAttr="lease-new-terms"');
    expect(header).toContain("showNewTerms");
    expect(header).not.toContain('label="Extend move-out"');
    expect(header).not.toContain('dataAttr="lease-extend"');
    expect(header).not.toContain('label="Renew"');
  });

  it("manager panel opens New terms for signed rows including off-platform", () => {
    expect(panel).toContain("onNewTerms");
    expect(panel).toContain('variant="new-terms"');
    expect(panel).toContain("leases-bulk-new-terms");
    expect(modal).toContain('variant === "new-terms"');
    expect(modal).toContain("Create and send");
    expect(modal).toContain('hideRentHint ? "Starts"');
    expect(modal).toContain("House listing");
    expect(modal).toContain('variant === "new-terms" ? null : (');
  });
});
