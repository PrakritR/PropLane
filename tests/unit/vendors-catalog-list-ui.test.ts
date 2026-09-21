import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AXIS_VENDOR_CATALOG } from "@/lib/axis-vendor-catalog";
import { listManagerCatalogVendors } from "@/lib/vendor-catalog-list";
import type { ManagerVendorRow } from "@/lib/manager-vendors-storage";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

function roster(partial: Partial<ManagerVendorRow> & Pick<ManagerVendorRow, "id" | "name">): ManagerVendorRow {
  return {
    managerUserId: "mgr-1",
    trade: "Plumbing",
    phone: "",
    email: "",
    notes: "House plumber",
    active: true,
    ...partial,
  };
}

describe("listManagerCatalogVendors", () => {
  it("keeps curated rows and appends this account’s shared roster vendors", () => {
    const rows = listManagerCatalogVendors([
      roster({ id: "v-shared", name: "Apex Local", shareOnProplane: true }),
      roster({ id: "v-private", name: "Keep Private", shareOnProplane: false }),
    ]);
    expect(rows.some((row) => row.name === "Northwest Plumbing Co")).toBe(true);
    expect(rows.some((row) => row.catalogId === "shared-v-shared")).toBe(true);
    expect(rows.some((row) => row.name === "Keep Private")).toBe(false);
    expect(rows.length).toBe(AXIS_VENDOR_CATALOG.length + 1);
  });

  it("does not duplicate a curated vendor already on the roster", () => {
    const rows = listManagerCatalogVendors([
      roster({
        id: "v-nw",
        name: "Northwest Plumbing Co",
        catalogId: "axis-catalog-plumbing-nw",
        shareOnProplane: true,
      }),
    ]);
    expect(rows.filter((row) => row.name === "Northwest Plumbing Co")).toHaveLength(1);
  });
});

describe("vendors catalog list chrome", () => {
  it("drops the empty-state PropLane button and dashed footer Add", () => {
    const panel = read("src/components/portal/pro-vendors-panel.tsx");
    expect(panel).toContain("vendors-empty-add");
    expect(panel).not.toContain("vendors-empty-proplane");
    expect(panel).not.toContain("vendors-add-footer");
    expect(panel).toContain("vendors-catalog-close");
    expect(panel).toContain("View");
    expect(panel).toContain("Add to your vendors");
    expect(panel).toContain("onSelectedChange");
    expect(panel).not.toContain("trailing={<RecordActionMenu");
  });

  it("gives the catalog profile an X back to the list", () => {
    // The page chrome (PortalRecordDetailPage + the X back button) is owned by the
    // panel, the same split already used for the real vendor detail (see
    // pro-vendor-detail.tsx / portal-parity-tranche.test.ts) — pro-vendor-catalog-detail.tsx
    // renders only the tabbed content.
    const panel = read("src/components/portal/pro-vendors-panel.tsx");
    const detail = read("src/components/portal/pro-vendor-catalog-detail.tsx");
    expect(panel).toContain("vendor-catalog-back");
    expect(panel).toContain("PortalRecordDetailPage");
    expect(detail).toContain("About");
  });
});
