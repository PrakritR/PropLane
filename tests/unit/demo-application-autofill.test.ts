import { describe, expect, it, vi } from "vitest";
import {
  CANONICAL_DEMO_GUIDED_EMAIL,
  CANONICAL_DEMO_GUIDED_NAME,
} from "@/lib/demo/demo-canonical-accounts";
import { buildDemoApplicationAutofill } from "@/lib/demo/demo-application-autofill";
import { LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/data";
import { countValidationErrors, validateRentalWizardStep } from "@/lib/rental-application/validate";
import { RENTAL_WIZARD_STEP_COUNT } from "@/lib/rental-application/types";

const TEST_PROPERTY_ID = "mgr-harbor-view-demo";

vi.mock("@/lib/rental-application/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rental-application/data")>();
  return {
    ...actual,
    getRoomOptionsForProperty: vi.fn((propertyId: string) => {
      if (propertyId !== TEST_PROPERTY_ID) return [];
      return [
        {
          value: `${TEST_PROPERTY_ID}${LISTING_ROOM_CHOICE_SEP}room-a`,
          label: "Room A · $1,200/mo",
        },
        {
          value: `${TEST_PROPERTY_ID}${LISTING_ROOM_CHOICE_SEP}room-b`,
          label: "Room B · $1,150/mo",
        },
      ];
    }),
  };
});

describe("buildDemoApplicationAutofill", () => {
  it("targets the listed property and first available room", () => {
    const form = buildDemoApplicationAutofill(TEST_PROPERTY_ID);
    expect(form.propertyId).toBe(TEST_PROPERTY_ID);
    expect(form.roomChoice1).toBe(`${TEST_PROPERTY_ID}${LISTING_ROOM_CHOICE_SEP}room-a`);
    expect(form.roomChoice2).toBe(`${TEST_PROPERTY_ID}${LISTING_ROOM_CHOICE_SEP}room-b`);
    expect(form.email).toBe(CANONICAL_DEMO_GUIDED_EMAIL);
    expect(form.fullLegalName).toBe(CANONICAL_DEMO_GUIDED_NAME);
  });

  it("passes wizard validation for steps 1–10", () => {
    const form = buildDemoApplicationAutofill(TEST_PROPERTY_ID);
    for (let step = 1; step <= RENTAL_WIZARD_STEP_COUNT; step++) {
      const errors = validateRentalWizardStep(step, form);
      expect(countValidationErrors(errors), `step ${step} errors: ${JSON.stringify(errors)}`).toBe(0);
    }
    expect(form.leaseTerm).toBe("12-Month");
    expect(form.consentCredit).toBe(true);
    expect(form.applicationFeeAcknowledged).toBe(true);
    expect(RENTAL_WIZARD_STEP_COUNT).toBe(7);
  });
});
