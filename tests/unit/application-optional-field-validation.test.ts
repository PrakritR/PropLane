import { describe, expect, it } from "vitest";
import { createInitialRentalWizardState } from "@/lib/rental-application/state";
import { validateStandardWizardStep } from "@/lib/rental-application/validate";

describe("application optional values", () => {
  const optional = () => false;
  const enabled = () => true;

  it("validates populated lease dates even when optional", () => {
    const base = { ...createInitialRentalWizardState(), propertyId: "property-a", rentalType: "standard" as const, leaseStart: "2027-12-01", leaseEnd: "2027-11-01", roomChoice1: "room-a", roomChoice2: "room-a" };
    const errors = validateStandardWizardStep(1, base, optional, undefined, enabled);
    expect(errors.leaseEnd).toMatch(/after lease start/);
    expect(validateStandardWizardStep(1, { ...base, leaseStart: "2027-02-31" }, optional, undefined, enabled).leaseStart).toMatch(/valid/);
  });

  it("never refuses a step for a legacy 2nd/3rd room pick nothing renders any more", () => {
    // The wizard asks for ONE room, so there is no 2nd/3rd picker, no inline error and no scroll
    // anchor for one. An error on those keys would block step 1 with nothing on screen to fix.
    const legacy = {
      ...createInitialRentalWizardState(),
      propertyId: "property-a",
      rentalType: "standard" as const,
      roomChoice1: "room-a",
      roomChoice2: "room-a",
      roomChoice3: "room-a",
    };
    const errors = validateStandardWizardStep(1, legacy, optional, undefined, enabled);
    expect(errors.roomChoice2).toBeUndefined();
    expect(errors.roomChoice3).toBeUndefined();
  });

  it("requires Pets only when configured and checks optional address dates when entered", () => {
    const base = createInitialRentalWizardState();
    expect(validateStandardWizardStep(6, base, optional, undefined, enabled).pets).toBeUndefined();
    expect(validateStandardWizardStep(6, base, (key) => key === "pets", undefined, enabled).pets).toMatch(/required/);
    const dates = validateStandardWizardStep(3, { ...base, currentMoveIn: "2027-12-01", currentMoveOut: "2027-11-01" }, optional, undefined, enabled);
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
