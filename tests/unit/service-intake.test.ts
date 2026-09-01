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
  it("includes property catalog, maintenance, and custom add-on", () => {
    const options = buildServiceIntakeOptions([catalogOffer]);
    expect(options.some((option) => option.key === "addon:offer-parking")).toBe(true);
    expect(options.some((option) => option.key === `repair:${MAINTENANCE_SERVICE_OFFER_ID}`)).toBe(true);
    expect(options.some((option) => option.label === "Maintenance")).toBe(true);
    expect(options.some((option) => option.key === "addon:custom")).toBe(true);
    expect(options.some((option) => option.key === "repair:Plumbing")).toBe(false);
  });
});

describe("service intake helpers", () => {
  const options = buildServiceIntakeOptions([catalogOffer]);

  it("routes maintenance category to work-order taxonomy", () => {
    const maintenance = findServiceIntakeOption(options, `repair:${MAINTENANCE_SERVICE_OFFER_ID}`);
    expect(maintenance?.kind).toBe("repair");
    expect(serviceIntakeCategoryForOption(maintenance, "Electrical")).toBe("electrical");
    expect(serviceIntakeSuggestedTitle(maintenance, "Electrical")).toContain("electrical");
  });

  it("detects custom add-on option", () => {
    const custom = findServiceIntakeOption(options, "addon:custom");
    expect(serviceIntakeIsCustomAddOn(custom)).toBe(true);
    expect(serviceIntakeIsCustomAddOn(findServiceIntakeOption(options, "addon:offer-parking"))).toBe(false);
  });
});
