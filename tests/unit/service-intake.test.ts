import { describe, expect, it } from "vitest";
import {
  MAINTENANCE_SERVICE_OFFER_ID,
  isMaintenanceServiceOffer,
  resolveDefaultVendorForMaintenance,
  vendorTradeForMaintenanceCategory,
} from "@/lib/service-intake";
import {
  saveManagerVendorCategorySettings,
  type ManagerVendorRow,
} from "@/lib/manager-vendors-storage";

describe("service-intake", () => {
  it("identifies maintenance offer id", () => {
    expect(isMaintenanceServiceOffer(MAINTENANCE_SERVICE_OFFER_ID)).toBe(true);
    expect(isMaintenanceServiceOffer("custom")).toBe(false);
  });

  it("maps maintenance categories to vendor trades", () => {
    expect(vendorTradeForMaintenanceCategory("Plumbing")).toBe("Plumbing");
    expect(vendorTradeForMaintenanceCategory("Appliance")).toBe("Appliance repair");
    expect(vendorTradeForMaintenanceCategory("General")).toBe("General maintenance");
  });

  it("resolves default vendor by trade settings", () => {
    saveManagerVendorCategorySettings(
      { defaultVendorIdByTrade: { Plumbing: "v-plumber" } },
      "mgr-1",
    );
    const vendors: ManagerVendorRow[] = [
      {
        id: "v-plumber",
        managerUserId: "mgr-1",
        name: "Pipe Pro",
        trade: "Plumbing",
        phone: "",
        email: "",
        notes: "",
        active: true,
      },
    ];
    const match = resolveDefaultVendorForMaintenance("mgr-1", "Plumbing", vendors);
    expect(match?.id).toBe("v-plumber");
  });
});
