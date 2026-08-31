import { describe, expect, it } from "vitest";
import {
  MAINTENANCE_SERVICE_OFFER_ID,
  buildServiceIntakeOptions,
  findServiceIntakeOption,
  isMaintenanceServiceOffer,
  resolveDefaultVendorForMaintenance,
  serviceIntakeCategoryForOption,
  serviceIntakeIsCustomAddOn,
  serviceIntakeSuggestedTitle,
  vendorTradeForMaintenanceCategory,
  RESIDENT_SERVICE_REPAIR_CATEGORIES,
} from "@/lib/service-intake";
import {
  saveManagerVendorCategorySettings,
  type ManagerVendorRow,
} from "@/lib/manager-vendors-storage";
import type { ManagerListingServiceOption } from "@/lib/manager-listing-submission";

const catalogOffer: ManagerListingServiceOption = {
  id: "offer-parking",
  name: "Parking spot",
  description: "Monthly parking",
  price: "$75/mo",
  deposit: "",
  available: true,
};

describe("maintenance service intake (legacy manager path)", () => {
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

describe("buildServiceIntakeOptions", () => {
  it("includes property catalog, repair categories, and custom add-on", () => {
    const options = buildServiceIntakeOptions([catalogOffer]);
    expect(options.some((option) => option.key === "addon:offer-parking")).toBe(true);
    expect(options.some((option) => option.key === "repair:Plumbing")).toBe(true);
    expect(options.some((option) => option.key === "addon:custom")).toBe(true);
    expect(
      RESIDENT_SERVICE_REPAIR_CATEGORIES.every((category) =>
        options.some((option) => option.categoryLabel === category),
      ),
    ).toBe(true);
  });
});

describe("service intake helpers", () => {
  const options = buildServiceIntakeOptions([catalogOffer]);

  it("routes repair categories to work-order taxonomy", () => {
    const electrical = findServiceIntakeOption(options, "repair:Electrical");
    expect(electrical?.kind).toBe("repair");
    expect(serviceIntakeCategoryForOption(electrical, "General")).toBe("electrical");
    expect(serviceIntakeSuggestedTitle(electrical, "Electrical")).toContain("electrical");
  });

  it("detects custom add-on option", () => {
    const custom = findServiceIntakeOption(options, "addon:custom");
    expect(serviceIntakeIsCustomAddOn(custom)).toBe(true);
    expect(serviceIntakeIsCustomAddOn(findServiceIntakeOption(options, "addon:offer-parking"))).toBe(false);
  });
});
