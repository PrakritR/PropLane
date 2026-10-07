// The vendor Services list and service record follow the shared anatomy (vendor-portal-redesign-1006):
// rows are the shared row with stage actions in the ⋯ only, and the record has no loose button strip.
// Reads source, like tests/unit/portal-list-rows-no-pills.test.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (rel: string) =>
  readFileSync(join(process.cwd(), rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("vendor Services list", () => {
  const panel = read("src/components/portal/vendor-work-orders-panel.tsx");

  it("every stage row is the shared row with a ⋯ built from vendorServiceActions", () => {
    expect(panel).toContain("vendorServiceActions");
    expect(panel).toMatch(/<VendorServiceCardRow[\s\S]*actions=\{/);
    expect(panel).toContain("RowActionsMenu");
  });

  it("draws no pill and no loose option strip", () => {
    expect(panel).not.toMatch(/\bBadge\b|portal-badge/);
    expect(panel).not.toContain("VendorJobChoiceBar");
    expect(panel).not.toContain("PortalTableDetailActions");
  });
});

describe("vendor service record", () => {
  const panel = read("src/components/portal/vendor-work-orders-panel.tsx");
  const bid = read("src/components/portal/vendor-estimate-bid-section.tsx");

  it("shows the stage stepper once in the record, not inside Estimate & bid", () => {
    expect(panel).toContain("ServiceStageStepper");
    expect(bid).not.toContain("ServiceStageStepper");
  });

  it("Estimate & bid answers are underline tabs, not the segmented radio bar", () => {
    expect(bid).toContain("LocalDestinationNav");
    expect(bid).not.toContain('role="radiogroup"');
    expect(bid).not.toContain('role="radio"');
  });

  it("the header carries Message the manager, the primary, and a ⋯ - sections draw icon actions only", () => {
    expect(panel).toContain('label="Message the manager"');
    expect(panel).toContain("PortalPrimaryIconAction");
    expect(panel).toContain("headerMenu");
    // The old "Send invoice" / "Complete" labelled buttons inside section bodies are icon actions now.
    expect(panel).not.toMatch(/<Button[^>]*data-attr="vendor-send-invoice"/);
    expect(panel).not.toMatch(/<Button[^>]*data-attr="vendor-mark-done"/);
  });
});
