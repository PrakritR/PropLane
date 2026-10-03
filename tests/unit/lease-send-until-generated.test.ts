import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// A lease is never SENT without a document — but the document is now made by the Send lease screen itself
// (the PropLane lease is generated from the saved terms, or a PDF is uploaded on its second side), so the
// header's Send is offered on every draft and the gate lives where the document is made.
describe("lease send is gated on a document, inside the Send lease screen", () => {
  const primaryActions = readFileSync(join(process.cwd(), "src/components/portal/lease-primary-header-actions.tsx"), "utf8");
  const pipelinePanel = readFileSync(join(process.cwd(), "src/components/portal/pro-leases-pipeline-panel.tsx"), "utf8");
  const sheet = readFileSync(join(process.cwd(), "src/components/portal/lease-send-sheet.tsx"), "utf8");

  it("the header offers Send on a draft whether or not its document exists yet", () => {
    expect(primaryActions).toMatch(/const showSendToResident\s*=\s*\n?\s*\(row\.status === "Manager Review" \|\| row\.status === "Draft"\) &&/);
  });

  it("the screen makes the document before it will send, and its button stays closed without one", () => {
    expect(sheet).toContain("generateLeaseHtmlForRow");
    expect(sheet).toContain("documentReady");
    expect(sheet).toMatch(/const canSend = Boolean\(\s*lease && terms && !termsBlocked && documentReady && confirmed/);
  });

  it("the sheet still runs the shared send gate immediately before sending", () => {
    expect(sheet).toContain("leaseSendGateBlocker(fresh)");
    expect(sheet).toContain("sendLeaseToResident(lease.id, managerUserId)");
  });

  // The record's header renders the SAME shared actions; the panel does not re-implement the rule.
  it("lease pipeline detail delegates Send to the shared header actions", () => {
    expect(pipelinePanel).toContain(
      'import { LeasePrimaryHeaderActions } from "@/components/portal/lease-primary-header-actions"',
    );
    expect(pipelinePanel).toContain("<LeasePrimaryHeaderActions");
    expect(pipelinePanel).not.toMatch(/const showSendToResident\s*=/);
  });
});
