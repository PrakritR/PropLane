import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const leaseActions = readFileSync(
  join(process.cwd(), "src/components/portal/lease-primary-header-actions.tsx"),
  "utf8",
);
const leasePanel = readFileSync(
  join(process.cwd(), "src/components/portal/pro-leases-pipeline-panel.tsx"),
  "utf8",
);
const applications = readFileSync(
  join(process.cwd(), "src/components/portal/pro-applications.tsx"),
  "utf8",
);

describe("lease and application record headers are icons only", () => {
  it("lease header actions never open a ⋯ fit row", () => {
    expect(leaseActions).toContain("PortalIconAction");
    expect(leaseActions).toContain("data-attr=\"lease-header-icons\"");
    expect(leaseActions).toContain("leaseAllowsSignedPdfUpload");
    expect(leaseActions).not.toContain("PortalFooterFitActionRow");
    expect(leaseActions).not.toContain("More lease actions");
    expect(leaseActions).not.toMatch(/>\s*Download\s*</);
  });

  it("lease and application detail pages publish icons into the title row", () => {
    expect(leasePanel).toContain("iconTitleActions");
    expect(leasePanel).toContain("leaseAllowsSignedPdfUpload");
    expect(leasePanel).toContain("setMarkSignedRowId(rowId)");
    expect(applications).toContain("iconTitleActions");
    expect(applications).toContain("data-attr=\"application-header-icons\"");
    expect(applications).not.toContain("More application actions");
  });
});
