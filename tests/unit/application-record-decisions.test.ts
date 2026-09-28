import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const applications = readFileSync(
  join(process.cwd(), "src/components/portal/pro-applications.tsx"),
  "utf8",
);

describe("application decisions C243 and C206", () => {
  it("Approve and Reject on the record are labeled commits", () => {
    const start = applications.indexOf("const renderApplicationRowActions");
    const end = applications.indexOf("const renderCosignerDetailActions");
    const block = applications.slice(start, end);
    expect(block).toContain('data-attr="application-approve"');
    expect(block).toContain('data-attr="application-reject"');
    expect(block).toMatch(/>\s*Approve\s*</);
    expect(block).toMatch(/>\s*Reject\s*</);
  });

  it("fee waiver codes open from the Applications header", () => {
    expect(applications).toContain('data-attr="applications-fee-waiver-codes"');
    expect(applications).toContain("ManagerApplicationFeeWaiverCodesModal");
    expect(applications).toContain("setFeeWaiverCodesOpen(true)");
  });
});
