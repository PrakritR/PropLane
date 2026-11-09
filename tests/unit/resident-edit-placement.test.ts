import { describe, expect, it } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { preserveUnchangedResidentPlacement } from "@/lib/resident-edit-placement";

const controls = { propertyId: "house", roomId: "room", bundleId: "", moveInDate: "2026-11-04", moveOutDate: "" };
const previous = {
  id: "fixture", application: { propertyId: "house", roomChoice1: "house::room", leaseStart: "2026-11-04", leaseEnd: "" },
  manualResidentDetails: {},
} as DemoApplicantRow;
const next = {
  ...previous, assignedPropertyId: "house", assignedRoomChoice: "house::room", signedMonthlyRent: 1100,
  application: { ...previous.application!, bundleId: "", managerUtilitiesOverride: "0", managerMoveInFeeOverride: "0" },
  manualResidentDetails: { roomNumber: "Room", moveInDate: "2026-11-04", monthlyUtilities: 0, moveInFee: 0 },
} as DemoApplicantRow;

describe("resident edit placement preservation", () => {
  it("preserves exact absent, null and empty placement fields while keeping pricing edits", () => {
    const source = { ...previous, assignedPropertyId: null } as unknown as DemoApplicantRow;
    const result = preserveUnchangedResidentPlacement(source, next, controls, { ...controls });
    expect(result.assignedPropertyId).toBeNull();
    expect(Object.hasOwn(result, "assignedRoomChoice")).toBe(false);
    expect(Object.hasOwn(result.application!, "bundleId")).toBe(false);
    expect(result.application?.leaseEnd).toBe("");
    expect(Object.hasOwn(result.manualResidentDetails!, "moveInDate")).toBe(false);
    expect(result.signedMonthlyRent).toBe(1100);
    expect(result.manualResidentDetails).toMatchObject({ monthlyUtilities: 0, moveInFee: 0 });
    expect(result.application).toMatchObject({ managerUtilitiesOverride: "0", managerMoveInFeeOverride: "0" });
  });
  it.each([{ roomId: "other" }, { moveInDate: "2026-11-05" }, { propertyId: "other" }, { bundleId: "bundle" }, { moveOutDate: "2027-01-01" }])("retains new placement when controls change: %o", (change) => {
    expect(preserveUnchangedResidentPlacement(previous, next, controls, { ...controls, ...change })).toBe(next);
  });
  it("keeps non-placement fields on a manually added row with no prior application", () => {
    const source = { id: "manual", manuallyAdded: true, manualResidentDetails: {} } as DemoApplicantRow;
    const result = preserveUnchangedResidentPlacement(source, next, controls, controls);
    expect(result.application).toMatchObject({ managerUtilitiesOverride: "0", managerMoveInFeeOverride: "0" });
    expect(Object.hasOwn(result.application!, "roomChoice1")).toBe(false);
    expect(result.signedMonthlyRent).toBe(1100);
  });
  it("does not preserve without a baseline", () => {
    expect(preserveUnchangedResidentPlacement(previous, next, null, controls)).toBe(next);
  });
});
