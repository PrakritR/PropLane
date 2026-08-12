// @vitest-environment jsdom
/**
 * Render regression + evidence harness: renders the REAL "Generate lease"
 * modal for a property that holds lease formats and for one that holds none,
 * writing the markup to EVIDENCE_DIR (when set) for screenshotting.
 */
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { mkdirSync, writeFileSync } from "node:fs";

vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: () => {} }),
}));

let SUBMISSION: unknown = null;
vi.mock("@/lib/rental-application/data", () => ({
  getPropertyById: () => ({ listingSubmission: SUBMISSION }),
}));
vi.mock("@/lib/lease-pipeline-storage", () => ({
  resolveManagerLeaseGenerationRow: (_id: string) => ROW,
  leaseApplicationSnapshotForRow: () => ({ leaseTerm: "12-Month", rentalType: "long-term" }),
  leaseGenerationPreviewContextForRow: () => ({ ok: true }),
  generateLeaseHtmlForRow: () => ({ ok: true, version: 1 }),
}));
vi.mock("@/lib/generated-lease", () => ({
  buildAiGeneratedLeaseHtml: () => ({
    kind: "generated",
    html: "<h1>Residential lease</h1><p>Between Test Manager and Priya Raman for 5259 Brooklyn Ave NE.</p>",
  }),
}));

import { LeaseGenerateModal } from "@/components/portal/lease-generate-modal";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import { addLeaseTemplateFromSeed } from "@/lib/property-lease-template-sync";

const ROW = {
  id: "lease-1",
  propertyId: "mgr-evidence-house",
  leaseKind: "individual",
  resident: "Priya Raman",
} as never;

// Same convention as `evidence-manager-money-agreement.test.tsx`: the render is
// always exercised, the HTML is only written when EVIDENCE_DIR asks for it.
const OUT = process.env.EVIDENCE_DIR ?? "";

function writeShot(name: string, caption: string, body: string) {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    `${OUT}/${name}.html`,
    `<!doctype html><html lang="en" class="h-full antialiased" data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="./app.css"></head>
<body class="min-h-full overflow-x-clip bg-background text-foreground">
<p style="font:600 13px/1.4 system-ui;color:#64748b;margin:16px auto 0;max-width:1000px;padding:0 16px">${caption}</p>
${body}</body></html>`,
  );
}

describe("evidence · generate-lease picker follows the property's real formats", () => {
  it("lists the formats the property holds", () => {
    SUBMISSION = addLeaseTemplateFromSeed(
      addLeaseTemplateFromSeed(createDefaultListingSubmission(), "primary"),
      "short-term",
    );
    render(
      <LeaseGenerateModal open row={ROW} managerUserId="mgr-1" onClose={() => {}} onGenerated={() => {}} />,
    );
    expect(document.body.textContent).toContain("Long-term lease");
    expect(document.body.textContent).toContain("Short-term lease");
    writeShot(
      "generate-with-templates",
      "E · Generate lease — the picker lists the formats this property actually holds (no permanently greyed-out 'Lease bundle' buttons).",
      document.body.innerHTML,
    );
    document.body.innerHTML = "";
  });

  it("explains the fallback when the property holds none", () => {
    SUBMISSION = createDefaultListingSubmission();
    render(
      <LeaseGenerateModal open row={ROW} managerUserId="mgr-1" onClose={() => {}} onGenerated={() => {}} />,
    );
    expect(document.body.textContent).toContain("no saved lease formats");
    expect(
      document.querySelector<HTMLButtonElement>('button[data-attr="lease-generate-confirm"]')?.disabled,
    ).toBe(false);
    writeShot(
      "generate-no-templates",
      "F · Same modal on a property with no saved formats — it says the draft falls back to the property's own lease terms, and Generate stays enabled.",
      document.body.innerHTML,
    );
    document.body.innerHTML = "";
  });
});
