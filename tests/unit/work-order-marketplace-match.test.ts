import { describe, expect, it } from "vitest";
import {
  extractZipFromAddress,
  filterMarketplaceVendorUserIds,
} from "@/lib/work-order-marketplace-match.server";

describe("work-order marketplace match", () => {
  it("extracts zip from a full address", () => {
    expect(extractZipFromAddress("5257 Brooklyn Ave NE, Seattle, WA 98105")).toBe("98105");
  });

  it("matches trade, license, insurance, and zip radius", () => {
    const profiles = [
      {
        user_id: "plumber",
        trades: ["Plumbing"],
        service_area_zips: ["98105", "98102"],
        service_radius_miles: 8,
        license_number: "L-1",
        insurance_expires_at: "2099-01-01",
        insurance_doc_path: "doc.pdf",
        directory_listed: true,
        onboarding_completed_at: "2026-01-01",
      },
      {
        user_id: "electric",
        trades: ["Electrical"],
        service_area_zips: ["98105"],
        service_radius_miles: 8,
        license_number: "L-2",
        insurance_expires_at: "2099-01-01",
        insurance_doc_path: "doc.pdf",
        directory_listed: true,
        onboarding_completed_at: "2026-01-01",
      },
      {
        user_id: "uninsured",
        trades: ["Plumbing"],
        service_area_zips: ["98105"],
        service_radius_miles: 8,
        license_number: "L-3",
        insurance_expires_at: null,
        insurance_doc_path: null,
        directory_listed: true,
        onboarding_completed_at: "2026-01-01",
      },
    ];
    const ids = filterMarketplaceVendorUserIds(profiles, {
      propertyZip: "98105",
      publishRadiusMi: 5,
      category: "plumbing",
    });
    expect(ids).toEqual(["plumber"]);
  });
});
