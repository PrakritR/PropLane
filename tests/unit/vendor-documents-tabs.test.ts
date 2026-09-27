import { describe, expect, it } from "vitest";
import {
  VENDOR_DOCUMENT_TABS,
  vendorDocumentSectionForTab,
  vendorDocumentStatusLabel,
  vendorDocumentStatusTone,
} from "@/lib/vendor-documents";

describe("vendor document tabs", () => {
  it("exposes tab metadata for each section", () => {
    expect(VENDOR_DOCUMENT_TABS.map((tab) => tab.id)).toEqual(["tax", "insurance", "licensing"]);
    expect(vendorDocumentSectionForTab("tax")?.kinds).toContain("w9");
    expect(vendorDocumentSectionForTab("insurance")?.kinds).toContain("insurance");
  });

  it("labels document status for table rows", () => {
    expect(vendorDocumentStatusLabel(undefined)).toBe("Missing");
    expect(
      vendorDocumentStatusLabel({
        kind: "w9",
        fileName: "w9.pdf",
        url: "/api/vendor/documents/file?kind=w9",
        uploadedAt: new Date().toISOString(),
      }),
    ).toBe("On file");
    expect(vendorDocumentStatusTone(undefined)).toContain("portal-badge-pending");
  });
});
