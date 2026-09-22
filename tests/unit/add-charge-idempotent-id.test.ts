/**
 * @vitest-environment jsdom
 *
 * `createManagerCharge` now accepts an optional caller-supplied `id`. The Add charge
 * modal mints that id ONCE when it opens and reuses it across a retried submit (e.g. a
 * double-click landing before the confirm button's disabled state re-renders), so the
 * server's `onConflict: "id"` upsert makes the retry idempotent instead of creating a
 * second charge for the same submit.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createManagerCharge, readHouseholdCharges } from "@/lib/household-charges";

const MANAGER = "mgr-idempotent-charge";

function input(overrides: Partial<Parameters<typeof createManagerCharge>[0]> = {}) {
  return {
    residentEmail: "resident@example.com",
    residentName: "Resident One",
    propertyId: "prop-1",
    propertyLabel: "Test House",
    managerUserId: MANAGER,
    title: "Parking",
    amount: 50,
    ...overrides,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("createManagerCharge with a supplied id", () => {
  it("uses the supplied id instead of generating one", () => {
    const charge = createManagerCharge(input({ id: "hc_mgr_fixed_1" }));
    expect(charge?.id).toBe("hc_mgr_fixed_1");
  });

  it("generates an id as before when none is supplied", () => {
    const charge = createManagerCharge(input());
    expect(charge?.id).toMatch(/^hc_mgr_/);
  });

  it("a retried submit with the same id never creates a second charge", () => {
    const first = createManagerCharge(input({ id: "hc_mgr_retry_1", title: "Rent" }));
    const second = createManagerCharge(input({ id: "hc_mgr_retry_1", title: "Rent" }));
    expect(first?.id).toBe("hc_mgr_retry_1");
    expect(second?.id).toBe("hc_mgr_retry_1");

    const matching = readHouseholdCharges().filter((c) => c.id === "hc_mgr_retry_1");
    expect(matching).toHaveLength(1);
  });
});
