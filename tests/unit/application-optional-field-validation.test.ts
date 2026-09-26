import { describe, expect, it } from "vitest";
import { createInitialRentalWizardState } from "@/lib/rental-application/state";
import { validateStandardWizardStep } from "@/lib/rental-application/validate";

describe("application optional values", () => {
  const optional = () => false;
  const enabled = () => true;

  it("validates populated lease dates and room choices even when optional", () => {
    const base = { ...createInitialRentalWizardState(), propertyId: "property-a", rentalType: "standard" as const, leaseStart: "2027-12-01", leaseEnd: "2027-11-01", roomChoice1: "room-a", roomChoice2: "room-a" };
    const errors = validateStandardWizardStep(3, base, optional, undefined, enabled);
    expect(errors.leaseEnd).toMatch(/after lease start/);
    expect(errors.roomChoice2).toMatch(/differ/);
    expect(validateStandardWizardStep(3, { ...base, leaseStart: "2027-02-31" }, optional, undefined, enabled).leaseStart).toMatch(/valid/);
  });

  it("requires Pets only when configured and checks optional address dates when entered", () => {
    const base = createInitialRentalWizardState();
    expect(validateStandardWizardStep(8, base, optional, undefined, enabled).pets).toBeUndefined();
    expect(validateStandardWizardStep(8, base, (key) => key === "pets", undefined, enabled).pets).toMatch(/required/);
    const dates = validateStandardWizardStep(4, { ...base, currentMoveIn: "2027-12-01", currentMoveOut: "2027-11-01" }, optional, undefined, enabled);
    expect(dates.currentMoveOut).toMatch(/follow/);
  });

  it("allows an unanswered optional group, but validates a selected group", () => {
    const base = createInitialRentalWizardState();
    expect(validateStandardWizardStep(1, base, optional, undefined, enabled)).toEqual({});
    expect(validateStandardWizardStep(1, { ...base, applyingAsGroup: "yes", groupSize: "0" }, optional, undefined, enabled).groupSize).toBeTruthy();
    expect(validateStandardWizardStep(1, { ...base, applyingAsGroup: "yes", groupSize: "3" }, optional, undefined, enabled).groupSize).toBeUndefined();
    expect(validateStandardWizardStep(1, { ...base, applyingAsGroup: "no" }, optional, undefined, enabled)).toEqual({});
  });
});
