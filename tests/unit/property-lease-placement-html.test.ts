import { describe, expect, it } from "vitest";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import { WASHINGTON_LEASE_CONFIG } from "@/lib/lease-templates/types";
import {
  buildPlacementLeaseHtml,
  effectivePropertyLeaseTemplateHtml,
  isStalePropertyLeaseTemplateOverride,
  mergePropertyLeaseTemplateEditsOntoPlacement,
  propertyLeasePreviewBaselineHtml,
} from "@/lib/property-lease-placement-html";
import { leasePreviewContextFromSubmission } from "@/lib/property-lease-preview";
import type { PropertyLeaseTemplate } from "@/lib/property-lease-templates";
import { resolvePropertyLeaseEditHtml } from "@/lib/property-lease-edit";

const seattleSub = () => ({
  ...createDefaultListingSubmission(),
  buildingName: "The Pioneer",
  address: "12 Pike St, Seattle, WA",
  zip: "98101",
  city: "Seattle",
  state: "WA",
  allowedLeaseTerms: ["12-Month"],
  rooms: [
    {
      id: "r1",
      name: "12A",
      monthlyRent: 1000,
      floor: "",
      utilitiesEstimate: "200",
      prorateMethod: "auto",
      dailyRentRate: 0,
      dailyUtilitiesRate: 0,
      photoDataUrls: [],
      videoDataUrl: null,
      amenitiesText: "",
      bathroomAccessIds: [],
      sharedSpaceAccessIds: [],
    },
  ],
});

const longTermTemplate = (override = ""): PropertyLeaseTemplate => ({
  id: "tpl-long",
  kind: "long-term",
  label: "Long-term lease",
  listingSeedKey: "fixed-12-month",
  applicationLeaseTerms: ["12-Month"],
  leaseConfigMode: "standard",
  leaseCustomKind: "terms",
  customLeaseTerms: "",
  leaseTemplateDocUrl: null,
  leaseTemplateDocName: "",
  leaseTemplateHtmlOverride: override,
  createdAt: "",
  updatedAt: "",
});

describe("property lease placement html", () => {
  it("detects legacy standard-format overrides as stale under compact_room", () => {
    const sub = seattleSub();
    const baseline = propertyLeasePreviewBaselineHtml(sub, "long-term");
    expect(baseline).toContain("RESIDENTIAL ROOM LEASE AGREEMENT");

    const legacyOverride = `<!DOCTYPE html><html><body>
<h1>RESIDENTIAL LEASE AGREEMENT</h1>
<p class="sub">PROPLANE SEATTLE HOUSING</p>
<h2>1. PARTIES</h2>
<p>Generated ProPlane default template via ProPlane</p>
</body></html>`;
    expect(
      isStalePropertyLeaseTemplateOverride(legacyOverride, baseline, WASHINGTON_LEASE_CONFIG),
    ).toBe(true);
  });

  it("keeps manager section edits when merging onto placement html", () => {
    const sub = seattleSub();
    const baseline = propertyLeasePreviewBaselineHtml(sub, "long-term");
    const placementCtx = leasePreviewContextFromSubmission(sub, undefined, "long-term", {
      templatePreview: false,
    });
    placementCtx.application = {
      ...placementCtx.application,
      fullLegalName: "Alex Resident",
      email: "alex@example.com",
      leaseStart: "2026-09-01",
      leaseEnd: "2027-08-31",
    };

    const placementHtml = buildPlacementLeaseHtml(placementCtx, WASHINGTON_LEASE_CONFIG);
    expect(placementHtml).toContain("Alex Resident");

    const editedOverride = baseline.replace(
      "Filled at placement",
      "Filled at placement — custom landlord notice",
    );
    const merged = mergePropertyLeaseTemplateEditsOntoPlacement(placementHtml, editedOverride, baseline);
    expect(merged).toContain("custom landlord notice");
    expect(merged).toContain("Alex Resident");
  });

  it("resolvePropertyLeaseEditHtml ignores stale legacy override", () => {
    const legacyOverride = `<!DOCTYPE html><html><body>
<h1>RESIDENTIAL LEASE AGREEMENT</h1>
<p class="sub">PROPLANE SEATTLE HOUSING</p>
<h2>1. PARTIES</h2>
<p>Generated ProPlane default template via ProPlane</p>
</body></html>`;
    const sub = seattleSub();
    const html = resolvePropertyLeaseEditHtml({
      sub,
      draft: {
        leaseConfigMode: "standard",
        leaseCustomKind: "terms",
        customLeaseTerms: "",
        leaseTemplateDocUrl: null,
        leaseTemplateDocName: "",
        leaseTemplateHtmlOverride: legacyOverride,
      },
      source: "axis_default",
      templateKind: "long-term",
    });
    expect(html).toContain("RESIDENTIAL ROOM LEASE AGREEMENT");
    expect(html).not.toMatch(/<h1>\s*RESIDENTIAL LEASE AGREEMENT\s*<\/h1>/i);
  });

  it("effectivePropertyLeaseTemplateHtml returns override when manager edited a section", () => {
    const sub = seattleSub();
    const baseline = propertyLeasePreviewBaselineHtml(sub, "long-term");
    const template = longTermTemplate(baseline.replace("Filled at placement", "Manager LLC"));
    const html = effectivePropertyLeaseTemplateHtml({
      sub,
      template,
      templateKind: "long-term",
      config: WASHINGTON_LEASE_CONFIG,
    });
    expect(html).toContain("Manager LLC");
  });
});