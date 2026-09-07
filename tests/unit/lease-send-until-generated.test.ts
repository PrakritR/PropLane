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

  // The detail footer does not re-implement the gate — it renders the SAME
  // `LeasePrimaryHeaderActions` the header uses, so the assertion above is the
  // one place the rule lives. Asserting a second copy of the literal here is
  // what rotted when the footer was migrated onto the shared component.
  it("lease pipeline detail footer delegates Send to the shared gated actions", () => {
    expect(pipelinePanel).toContain(
      'import { LeasePrimaryHeaderActions } from "@/components/portal/lease-primary-header-actions"',
    );
    expect(pipelinePanel).toContain("<LeasePrimaryHeaderActions");
    expect(pipelinePanel).not.toMatch(/const showSendToResident\s*=/);
  });
});
