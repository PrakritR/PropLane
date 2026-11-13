/**
 * A maintenance pass-through charge is a SERVICE charge in every place a person reads it.
 *
 * The generator used to persist "Work order · <title>", and the resident dashboard and
 * Payments render the stored title raw — so the retired word reached the resident even though
 * `tests/unit/services-vocabulary.test.ts` scans every component for it. New rows carry
 * "Service · "; rows written before the rename keep their stored title (the ledger, the money
 * and the ids are never rewritten) and are normalized on the way to the screen only.
 */
import { describe, expect, it } from "vitest";
import { householdChargeDisplayTitle } from "@/lib/household-charges";
import { SERVICE_CHARGE_TITLE_PREFIX, serviceChargeDisplayTitle } from "@/lib/service-charge-title";

describe("service charge display title", () => {
  it("generates the service prefix", () => {
    expect(SERVICE_CHARGE_TITLE_PREFIX).toBe("Service · ");
  });

  it("normalizes a legacy stored title", () => {
    expect(householdChargeDisplayTitle({ kind: "work_order_charge", title: "Work order · Leaky faucet" }))
      .toBe("Service · Leaky faucet");
    expect(householdChargeDisplayTitle({ kind: "work_order_charge", title: "Work order" })).toBe("Service");
  });

  it("passes a newly generated title through unchanged", () => {
    expect(householdChargeDisplayTitle({ kind: "work_order_charge", title: "Service · Leaky faucet" }))
      .toBe("Service · Leaky faucet");
  });

  it("is gated on the kind, so no other charge's title is rewritten", () => {
    expect(householdChargeDisplayTitle({ kind: "other_cost", title: "Work order · Leaky faucet" }))
      .toBe("Work order · Leaky faucet");
    expect(householdChargeDisplayTitle({ kind: "rent", title: "First month's rent" }))
      .toBe("First month's rent");
  });

  it("is the same decision the server routes and the ledger projection reach", () => {
    for (const charge of [
      { kind: "work_order_charge", title: "Work order · Leaky faucet" },
      { kind: "work_order_charge", title: "Service · Leaky faucet" },
      { kind: "other_cost", title: "Work order · Leaky faucet" },
    ] as const) {
      expect(serviceChargeDisplayTitle(charge)).toBe(householdChargeDisplayTitle(charge));
    }
  });

  it("falls back only when there is no stored title", () => {
    expect(householdChargeDisplayTitle({ kind: "rent", title: "   " })).toBe("Charge");
    expect(householdChargeDisplayTitle({ kind: "work_order_charge", title: undefined }, "—")).toBe("—");
  });
});
