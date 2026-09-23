import { beforeEach, describe, expect, it, vi } from "vitest";

const persistManagerVendorToServer = vi.fn().mockResolvedValue(true);
const upsertManagerVendor = vi.fn();

vi.mock("@/lib/manager-vendors-storage", () => ({
  makeVendorId: () => "vendor-catalog-1",
  persistManagerVendorToServer: (...args: unknown[]) => persistManagerVendorToServer(...args),
  upsertManagerVendor: (...args: unknown[]) => upsertManagerVendor(...args),
}));

import { ensureCatalogVendorOnRoster } from "@/lib/catalog-vendor-roster";
import type { ManagerVendorRow } from "@/lib/manager-vendors-storage";

const CATALOG = {
  catalogId: "axis-catalog-plumbing-nw",
  name: "Northwest Plumbing Co",
  trade: "Plumbing",
  city: "Seattle, WA",
  zip: "98101",
  phone: "(206) 555-0142",
  email: "jobs@nwplumbing.example",
  description: "Licensed plumber.",
  hourlyCents: 9500,
  serviceCents: 18500,
};

describe("ensureCatalogVendorOnRoster", () => {
  beforeEach(() => {
    persistManagerVendorToServer.mockResolvedValue(true);
    upsertManagerVendor.mockReset();
  });

  it("reuses an existing catalog match without writing a second row", async () => {
    const existing = {
      id: "already",
      managerUserId: "mgr-1",
      name: "Northwest Plumbing Co",
      trade: "Plumbing",
      phone: "(206) 555-0142",
      email: "jobs@nwplumbing.example",
      notes: "",
      active: true,
      catalogId: "axis-catalog-plumbing-nw",
    } as ManagerVendorRow;
    const row = await ensureCatalogVendorOnRoster({
      userId: "mgr-1",
      catalog: CATALOG,
      existing: [existing],
    });
    expect(row?.id).toBe("already");
    expect(persistManagerVendorToServer).not.toHaveBeenCalled();
  });

  it("writes a roster row from the catalog card", async () => {
    const row = await ensureCatalogVendorOnRoster({
      userId: "mgr-1",
      catalog: CATALOG,
      existing: [],
    });
    expect(row).toMatchObject({
      id: "vendor-catalog-1",
      catalogId: "axis-catalog-plumbing-nw",
      name: "Northwest Plumbing Co",
      email: "jobs@nwplumbing.example",
    });
    expect(persistManagerVendorToServer).toHaveBeenCalledOnce();
    expect(upsertManagerVendor).toHaveBeenCalledOnce();
  });
});
