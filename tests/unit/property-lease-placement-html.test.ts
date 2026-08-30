import { describe, expect, it } from "vitest";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import { WASHINGTON_LEASE_CONFIG } from "@/lib/lease-templates/types";
import {
  applyLeaseSectionBodyEdits,
  parseLeaseHtmlSections,
} from "@/lib/lease-html-sections";
import {
  buildPlacementLeaseHtml,
  effectivePropertyLeaseTemplateHtml,
  isStalePropertyLeaseTemplateOverride,
  mergePropertyLeaseTemplateEditsOntoPlacement,
  propertyLeasePreviewBaselineHtml,
} from "@/lib/property-lease-placement-html";
import type { PropertyLeaseTemplate } from "@/lib/property-lease-templates";
import { leasePreviewContextFromSubmission } from "@/lib/property-lease-preview";
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

  it("keeps editable manager section edits when merging onto placement html", () => {
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

    const houseRules = parseLeaseHtmlSections(baseline).find((section) => /house rules/i.test(section.title));
    expect(houseRules).toBeTruthy();
    const editedOverride = applyLeaseSectionBodyEdits(baseline, {
      [houseRules!.id]: `${houseRules!.bodyHtml}<p>Quiet hours begin at 9 PM on Sundays.</p>`,
    });
    const merged = mergePropertyLeaseTemplateEditsOntoPlacement(placementHtml, editedOverride, baseline);
    expect(merged).toContain("Quiet hours begin at 9 PM on Sundays");
    expect(merged).toContain("Alex Resident");
  });

  it("does not merge placement sections that still carry preview placeholders", () => {
    const sub = seattleSub();
    const baseline = propertyLeasePreviewBaselineHtml(sub, "long-term");
    const placementCtx = leasePreviewContextFromSubmission(sub, undefined, "long-term", {
      templatePreview: false,
    });
    placementCtx.application = {
      ...placementCtx.application,
      fullLegalName: "Alex Resident",
      leaseStart: "2026-09-01",
      leaseEnd: "2027-08-31",
    };
    const placementHtml = buildPlacementLeaseHtml(placementCtx, WASHINGTON_LEASE_CONFIG);
    const parties = parseLeaseHtmlSections(baseline).find((section) => /parties/i.test(section.title));
    expect(parties).toBeTruthy();

    const editedOverride = applyLeaseSectionBodyEdits(baseline, {
      [parties!.id]: parties!.bodyHtml.replace(
        "Filled at placement",
        "Filled at placement — custom landlord notice",
      ),
    });
    const merged = mergePropertyLeaseTemplateEditsOntoPlacement(placementHtml, editedOverride, baseline);
    expect(merged).toBe(placementHtml);
    expect(merged).toContain("Alex Resident");
    expect(merged).not.toContain("custom landlord notice");
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

  it("resolvePropertyLeaseEditHtml returns saved override for uploaded PDF templates", () => {
    const savedOverride = "<html><body><h2>1. Uploaded lease document</h2><p>Manager clause</p></body></html>";
    const html = resolvePropertyLeaseEditHtml({
      sub: seattleSub(),
      draft: {
        leaseConfigMode: "custom",
        leaseCustomKind: "document",
        customLeaseTerms: "",
        leaseTemplateDocUrl: "https://example.com/lease.pdf",
        leaseTemplateDocName: "Scan.pdf",
        leaseTemplateHtmlOverride: savedOverride,
      },
      source: "custom_format",
      templateKind: "long-term",
    });
    expect(html).toBe(savedOverride);
  });

  it("effectivePropertyLeaseTemplateHtml returns override when manager edited a section", () => {
    const sub = seattleSub();
    const baseline = propertyLeasePreviewBaselineHtml(sub, "long-term");
    const houseRules = parseLeaseHtmlSections(baseline).find((section) => /house rules/i.test(section.title));
    expect(houseRules).toBeTruthy();
    const template = longTermTemplate(
      applyLeaseSectionBodyEdits(baseline, {
        [houseRules!.id]: `${houseRules!.bodyHtml}<p>Manager LLC quiet-hours policy.</p>`,
      }),
    );
    const html = effectivePropertyLeaseTemplateHtml({
      sub,
      template,
      templateKind: "long-term",
      config: WASHINGTON_LEASE_CONFIG,
    });
    expect(html).toContain("Manager LLC quiet-hours policy");
  });
});
