import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { vendorPortal } from "@/lib/portals/vendor";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

/**
 * Status tabs (All / On file / Missing) are gone (VD16, 2026-09-27) — the
 * vendor's own checklist groups by section instead (VD17), rows read
 * "Required" / "Not uploaded" / "Uploaded <date>" (VD18), and the header
 * upload icon defaults its type picker to the first missing required
 * document (VD19). See tests/unit/vendor-documents-tabs.test.ts for the
 * lib-level section order/labels.
 */
describe("vendor Documents — no status tabs", () => {
  it("the registry section carries no tabs any more", () => {
    const documents = vendorPortal.sections.find((s) => s.section === "documents");
    expect(documents?.tabs).toEqual([]);
  });

  it("the panel no longer routes a status tab id, and the waiting-on-a-manager banner is gone (VD15)", () => {
    const source = read("src/components/portal/vendor-documents-panel.tsx");
    expect(source).not.toContain("DOCUMENT_STATUS_TABS");
    expect(source).not.toContain("STATUS_TAB_LABELS");
    expect(source).not.toContain("tabId");
    expect(source).not.toContain("Waiting on a manager");
    expect(source).not.toContain("vendor-documents-unlinked-banner");
  });

  it("routes any legacy status/category segment to the bare section, never a 404", () => {
    const source = read("src/lib/render-portal-section.tsx");
    expect(source).toContain('kind === "vendor" && section === "documents"');
    expect(source).toContain("redirect(`${def.basePath}/${section}`)");
  });
});

describe("vendor Documents — section grouping (VD17)", () => {
  const source = read("src/components/portal/vendor-documents-panel.tsx");

  it("groups the own checklist by section in Tax / Business license / Insurance order with an uploaded/total header", () => {
    expect(source).toContain("ownSectionsVisible");
    expect(source).toContain("uploadedCount");
    expect(source).toContain("totalCount");
    expect(source).toContain("vendor-documents-section");
  });
});

describe("vendor Documents — row wording (VD18)", () => {
  const source = read("src/components/portal/vendor-documents-panel.tsx");

  it("reads Required / Not uploaded / Uploaded <date>, never the old on-file/missing wording", () => {
    expect(source).toContain("Required");
    expect(source).toContain("Not uploaded");
    expect(source).toContain("`Uploaded ${safeFormatDateTime(doc.uploadedAt)}`");
    expect(source).not.toContain('"On file"');
    expect(source).not.toContain('"Missing — required"');
  });

  it("gives an uploaded row's ⋯ a Download action alongside Replace/Delete", () => {
    expect(source).toContain('data-attr="vendor-document-download"');
    expect(source).toContain("onDownload={doc ?");
  });
});

describe("vendor Documents — header upload picks the type (VD19)", () => {
  it("the panel computes a default kind (first missing required, else first missing) and passes it to the workspace", () => {
    const source = read("src/components/portal/vendor-documents-panel.tsx");
    expect(source).toContain("defaultUploadKind");
    expect(source).toContain("isVendorComplianceDocumentKind(row.kind)");
    expect(source).toContain("initialKind={defaultUploadKind}");
  });

  it("the upload workspace seeds its Type step from initialKind whenever it opens", () => {
    const source = read("src/components/portal/vendor-upload-document-workspace.tsx");
    expect(source).toContain("initialKind?: VendorDocumentKind");
    expect(source).toContain("setKind(initialKind ?? \"\")");
  });
});
