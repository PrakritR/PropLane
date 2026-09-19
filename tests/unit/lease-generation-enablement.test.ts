import { describe, expect, it, vi, beforeEach } from "vitest";
import { snapshotJordanLee } from "@/data/manager-application-snapshots";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import { leaseGenerationPreviewContextForRow, leaseGenerationSupportedForRow } from "@/lib/lease-pipeline-storage";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import * as managerApplications from "@/lib/manager-applications-storage";
import * as rentalData from "@/lib/rental-application/data";

function baseLeaseRow(overrides: Partial<LeasePipelineRow> = {}): LeasePipelineRow {
  return {
    id: "lease_test",
    residentName: "JUNAID MOHAMMED",
    residentEmail: "mdj.1342@gmail.com",
    unit: "5257 Brooklyn · 9 rooms · Room 1",
    stageLabel: "Manager review",
    updated: "Jul 27",
    bucket: "manager",
    pdfVersion: 1,
    notes: "",
    updatedAtIso: new Date().toISOString(),
    axisId: "PROPLANE-1EAB54A1",
    propertyId: "mgr--9-rooms-b1wf3z",
    roomChoice: "mgr--9-rooms-b1wf3z::room-1784675245528-1",
    status: "Draft",
    thread: [],
    ...overrides,
  };
}

describe("leaseGenerationSupportedForRow", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("enables generation for manager-review lease linked to application without embedded snapshot", () => {
    const app = snapshotJordanLee();
    vi.spyOn(managerApplications, "readManagerApplicationRows").mockReturnValue([
      {
        id: "PROPLANE-1EAB54A1",
        name: "JUNAID MOHAMMED",
        email: "mdj.1342@gmail.com",
        property: "5257 Brooklyn · 9 rooms",
        stage: "Approved",
        detail: "",
        bucket: "approved",
        assignedPropertyId: "mgr--9-rooms-b1wf3z",
        assignedRoomChoice: "mgr--9-rooms-b1wf3z::room-1784675245528-1",
        application: app,
      },
    ]);
    vi.spyOn(rentalData, "getPropertyById").mockReturnValue({
      id: "mgr--9-rooms-b1wf3z",
      title: "5257 Brooklyn · 9 rooms",
      tagline: "",
      address: "5257 Brooklyn Ave NE",
      zip: "98105",
      neighborhood: "University District",
      beds: 9,
      baths: 3,
      rentLabel: "$950 / month",
      available: "Now",
      petFriendly: false,
      buildingId: "b1",
      buildingName: "5257 Brooklyn",
      unitLabel: "9 rooms",
      adminPublishLive: true,
    });

    const result = leaseGenerationSupportedForRow(baseLeaseRow({ application: undefined }));
    expect(result).toEqual({ ok: true });
  });

  it("returns a clear error when no application answers exist", () => {
    vi.spyOn(managerApplications, "readManagerApplicationRows").mockReturnValue([]);
    const result = leaseGenerationSupportedForRow(baseLeaseRow({ axisId: undefined, application: undefined }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("No application data");
  });

  it("uses location-only Washington fallback without inventing a property identity", () => {
    vi.spyOn(managerApplications, "readManagerApplicationRows").mockReturnValue([]);
    const context = leaseGenerationPreviewContextForRow(
      baseLeaseRow({
        axisId: undefined,
        propertyId: undefined,
        roomChoice: undefined,
        application: { fullLegalName: "Resident Test", email: "resident@example.com" },
      }),
    );

    expect(context).not.toBeNull();
    expect(context?.propertyLocation).toEqual({ state: "WA" });
    expect(context?.listingProperty).toBeUndefined();
    expect(context?.leasedRoom).toBeUndefined();
    expect(context?.propertyLocation).not.toHaveProperty("id");
    expect(context?.propertyLocation).not.toHaveProperty("address");
  });

  it.each([
    ["state", { state: "TX" }],
    ["city", { city: "Austin" }],
    ["ZIP", { zip: "73301" }],
  ])("does not replace an explicit unsupported %s with the Washington fallback", (_label, location) => {
    vi.spyOn(managerApplications, "readManagerApplicationRows").mockReturnValue([]);
    vi.spyOn(rentalData, "getPropertyById").mockReturnValue({
      id: "unsupported-property",
      title: "Unsupported property",
      tagline: "",
      address: "",
      zip: location.zip ?? "",
      neighborhood: "",
      beds: 1,
      baths: 1,
      rentLabel: "$1,000 / month",
      available: "Now",
      petFriendly: false,
      buildingId: "unsupported-building",
      buildingName: "Unsupported property",
      unitLabel: "Room 1",
      listingSubmission: {
        ...createDefaultListingSubmission(),
        state: location.state ?? "",
        city: location.city ?? "",
        zip: location.zip ?? "",
      },
    });
    const row = baseLeaseRow({
      propertyId: "unsupported-property",
      roomChoice: undefined,
      application: {
        fullLegalName: "Resident Test",
        email: "resident@example.com",
        propertyId: "unsupported-property",
      },
    });

    const context = leaseGenerationPreviewContextForRow(row);
    expect(context).not.toBeNull();
    expect(context?.propertyLocation).toBeUndefined();
    expect(leaseGenerationSupportedForRow(row).ok).toBe(false);
  });
});
