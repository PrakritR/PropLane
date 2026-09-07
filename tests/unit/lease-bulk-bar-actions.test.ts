import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PANEL = readFileSync(
  join(process.cwd(), "src/components/portal/pro-leases-pipeline-panel.tsx"),
  "utf8",
);

describe("leases list bulk bar mirrors detail footer actions", () => {
  it("exposes move-to-review on resident-signature rows", () => {
    expect(PANEL).toContain('data-attr="leases-bulk-move-review"');
    expect(PANEL).toContain('status === "Resident Signature Pending"');
  });

  it("exposes signing reminder and manager sign for the other buckets", () => {
    expect(PANEL).toContain('data-attr="leases-bulk-signing-reminder"');
    expect(PANEL).toContain('data-attr="leases-bulk-sign"');
  });

  it("exposes renewal actions on fully signed rows", () => {
    expect(PANEL).toContain('data-attr="leases-bulk-renew"');
    expect(PANEL).toContain('data-attr="leases-bulk-extend"');
  });

  it("exposes review-import when a row carries an uploaded parse", () => {
    expect(PANEL).toContain('data-attr="leases-bulk-review-import"');
  });
});
