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
describe("vendor Documents — routed tabs by kind, no status tabs", () => {
  it("the registry section carries Tax · Business license · Insurance · Statements · From managers (vendor-portal-ia-1007)", () => {
    const documents = vendorPortal.sections.find((s) => s.section === "documents");
    expect(documents?.tabs.map((t) => t.id)).toEqual(["tax", "license", "insurance", "statements", "from-managers"]);
    expect(documents?.tabs.map((t) => t.id)).not.toContain("missing");
  });

  it("the panel routes a kind tab id, never a status tab, and the waiting-on-a-manager banner is gone (VD15)", () => {
    const source = read("src/components/portal/vendor-documents-panel.tsx");
    expect(source).not.toContain("DOCUMENT_STATUS_TABS");
    expect(source).not.toContain("STATUS_TAB_LABELS");
    expect(source).not.toContain("Waiting on a manager");
    expect(source).not.toContain("vendor-documents-unlinked-banner");
  });

  it("routes a legacy status/category segment somewhere that resolves, never a 404", () => {
    const source = read("src/lib/render-portal-section.tsx");
    expect(source).toContain('kind === "vendor" && section === "documents"');
    expect(source).toContain("vendorDocumentsHref(");
  });
});

describe("vendor Documents — section grouping (VD17)", () => {
  const source = read("src/components/portal/vendor-documents-panel.tsx");

  it("each uploads tab shows its own section of the checklist (Tax / Business license / Insurance)", () => {
    expect(source).toContain("VENDOR_DOCUMENT_TAB_SECTION");
    expect(source).toContain("ownRows.filter((row) => row.sectionId === sectionId)");
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
