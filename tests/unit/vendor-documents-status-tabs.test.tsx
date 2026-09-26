import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { vendorPortal } from "@/lib/portals/vendor";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("vendor Documents registry", () => {
  it("routes status as All / On file / Missing tabs with real hrefs, not a client-only toggle", () => {
    const documents = vendorPortal.sections.find((s) => s.section === "documents");
    expect(documents?.tabs.map((t) => t.id)).toEqual(["all", "on-file", "missing"]);
  });
});

describe("vendor Documents source", () => {
  const source = read("src/components/portal/vendor-documents-panel.tsx");

  it("has a Filter sheet with Source and Category only — Status lives on the tab, never duplicated", () => {
    expect(source).toContain("PortalFilterSortSheet");
    expect(source).toContain('label="Source"');
    expect(source).toContain('label="Category"');
    expect(source).not.toContain('label="Status"');
    expect(source).toContain("filterFieldCount={2}");
  });

  it("gives every own-document row a ⋯ with View/Replace/Delete via the shared RecordActionMenu pattern", () => {
    expect(source).toContain("VendorDocumentRowOverflow");
    expect(source).toContain("RecordActionMenu");
    expect(source).toContain('data-record-action-id="edit"');
    expect(source).toContain('data-record-action-id="delete"');
    // A missing document has nothing to view or delete — only Upload.
    expect(source).toContain("omitActionView={!doc}");
  });

  it("keeps the round Upload primary on portalListAddPrimaryLabel (a locked convention — see portal-list-band-add-labels.test.ts) and a dashed Upload document footer", () => {
    expect(source).toContain("portalListAddPrimaryLabel");
    expect(source).toContain('ariaLabel: "Upload document"');
  });

  it("place line reads category · filename, and an on-file row's facts never repeat the generic Missing text", () => {
    expect(source).toContain("`${sectionLabel} · ${doc?.fileName ?? \"—\"}`");
    expect(source).toContain('"On file"');
  });
});

describe("vendor Documents tab destinations", () => {
  it("builds real hrefs for the three status tabs off basePath", () => {
    const source = read("src/components/portal/vendor-documents-panel.tsx");
    expect(source).toContain("href: `${basePath}/documents/${id}`");
    expect(source).toContain('DOCUMENT_STATUS_TABS: DocumentStatusTab[] = ["all", "on-file", "missing"]');
  });
});
