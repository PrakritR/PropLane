import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("lease send is gated on a generated document", () => {
  const primaryActions = readFileSync(
    join(process.cwd(), "src/components/portal/lease-primary-header-actions.tsx"),
    "utf8",
  );
  const pipelinePanel = readFileSync(
    join(process.cwd(), "src/components/portal/pro-leases-pipeline-panel.tsx"),
    "utf8",
  );

  it("lease primary header actions require hasDocument before Send", () => {
    expect(primaryActions).toMatch(/const showSendToResident\s*=\s*\n?\s*hasDocument &&/);
  });

  it("lease pipeline bulk send requires a document for a single selection", () => {
    expect(pipelinePanel).toContain("hasLeaseDocument(singleSelectedLeaseRow)");
    expect(pipelinePanel).toContain("showBulkGenerateButton");
  });

  it("lease pipeline detail footer only shows Send when a document exists", () => {
    expect(pipelinePanel).toMatch(
      /const showSendToResident\s*=\s*\n?\s*hasDocument && \(row\.status === "Manager Review"/,
    );
  });
});
