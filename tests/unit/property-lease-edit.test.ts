import { describe, expect, it } from "vitest";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import {
  buildUploadedLeaseEditableHtml,
  normalizePropertyLeaseDocumentSource,
  resolvePropertyLeaseEditHtml,
} from "@/lib/property-lease-edit";
import { prependLeaseHtmlSection } from "@/lib/lease-html-sections";

describe("property lease edit", () => {
  it("normalizes legacy custom_comments to axis_default in the modal", () => {
    expect(normalizePropertyLeaseDocumentSource("custom_comments")).toBe("axis_default");
    expect(normalizePropertyLeaseDocumentSource("axis_default")).toBe("axis_default");
    expect(normalizePropertyLeaseDocumentSource("custom_format")).toBe("custom_format");
  });

  it("builds editable shell for uploaded PDF", () => {
    const html = buildUploadedLeaseEditableHtml("https://example.com/lease.pdf", "Scan.pdf");
    expect(html).toContain("Uploaded lease document");
    expect(html).toContain("https://example.com/lease.pdf");
    expect(html).toContain("Scan.pdf");
    expect(html).toMatch(/<h2>/);
  });

  it("prepends a new section before the first h2", () => {
    const base = "<html><body><h2>1. Rent</h2><p>Due monthly</p></body></html>";
    const next = prependLeaseHtmlSection(base, { title: "0. Intro", bodyHtml: "<p>Hello</p>" });
    expect(next.indexOf("0. Intro")).toBeLessThan(next.indexOf("1. Rent"));
  });

  it("resolves PropLane default html for Seattle listings", () => {
    const sub = {
      ...createDefaultListingSubmission(),
      buildingName: "The Pioneer",
      address: "12 Pike St, Seattle, WA",
      zip: "98101",
      allowedLeaseTerms: ["12-Month"],
      rooms: [
        {
          id: "r1",
          name: "12A",
          monthlyRent: 2400,
          floor: "",
          utilitiesEstimate: "",
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
    };
    const html = resolvePropertyLeaseEditHtml({
      sub,
      draft: { leaseConfigMode: "standard", leaseCustomKind: "terms" },
      source: "axis_default",
      demo: true,
    });
    expect(html).toContain("RESIDENTIAL ROOM LEASE AGREEMENT");
  });
});
