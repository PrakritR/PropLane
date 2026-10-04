// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ServiceIncomingPaymentsList } from "@/components/portal/service-incoming-payments-list";
import type { HouseholdCharge } from "@/lib/household-charges";
import { buildServiceIncomingRows, recurringPriceLabel } from "@/lib/service-incoming-payments";

afterEach(cleanup);

const charge = (over: Partial<HouseholdCharge>): HouseholdCharge =>
  ({
    id: "hc-1",
    createdAt: "2026-10-01T00:00:00.000Z",
    residentEmail: "liam@example.com",
    residentName: "Liam Foster",
    residentUserId: null,
    propertyId: "prop-1",
    propertyLabel: "Alder Row",
    managerUserId: "mgr-1",
    kind: "manager_charge",
    title: "Storage locker service fee",
    amountLabel: "$40.00",
    balanceLabel: "$40.00",
    status: "pending",
    dueDate: "2026-10-15",
    ...over,
  }) as unknown as HouseholdCharge;

const REQUEST = { serviceChargeId: "hc-fee", depositChargeId: "hc-dep", price: "$40 / month" };

describe("incoming payments for a service", () => {
  it("lists only this service's charges, not the resident's other charges", () => {
    const rows = buildServiceIncomingRows({
      charges: [
        charge({ id: "hc-fee" }),
        charge({ id: "hc-dep", title: "Storage locker deposit", amountLabel: "$50.00", balanceLabel: "$50.00" }),
        charge({ id: "hc-rent", title: "October rent", amountLabel: "$1,200.00", balanceLabel: "$1,200.00" }),
      ],
      request: REQUEST,
    });
    expect(rows.map((r) => r.row.id)).toEqual(["hc-fee", "hc-dep"]);
  });

  it("puts the recurring cadence on the fee row only", () => {
    const rows = buildServiceIncomingRows({ charges: [charge({ id: "hc-fee" }), charge({ id: "hc-dep" })], request: REQUEST });
    expect(rows.find((r) => r.row.id === "hc-fee")?.recurringLabel).toBe("$40 / month");
    expect(rows.find((r) => r.row.id === "hc-dep")?.recurringLabel).toBeUndefined();
    expect(recurringPriceLabel("$75")).toBeUndefined();
    expect(recurringPriceLabel("$20 per week")).toBe("$20 per week");
  });

  it("a maintenance service lists the charge stamped with its work order id", () => {
    const rows = buildServiceIncomingRows({ charges: [charge({ id: "hc-wo", workOrderId: "wo-1" } as never), charge({ id: "hc-x" })], workOrderId: "wo-1" });
    expect(rows.map((r) => r.row.id)).toEqual(["hc-wo"]);
  });

  it("has no rows when nothing was billed", () => {
    expect(buildServiceIncomingRows({ charges: [charge({ id: "hc-rent" })], request: REQUEST })).toEqual([]);
  });

  it("draws the shared Payments rows with the recurring fact, never bare text", () => {
    render(<ServiceIncomingPaymentsList rows={buildServiceIncomingRows({ charges: [charge({ id: "hc-fee" })], request: REQUEST })} />);
    expect(screen.getAllByText("Liam Foster").length).toBeGreaterThan(0);
    expect(screen.getByText("$40 / month")).toBeInTheDocument();
    expect(document.querySelectorAll('[data-attr="service-incoming-payment-row"]')).toHaveLength(1);
    expect(document.body.textContent).not.toMatch(/Charges:/);
  });

  it("shows the standard empty card with no charges", () => {
    render(<ServiceIncomingPaymentsList rows={[]} />);
    expect(document.querySelector('[data-attr="service-incoming-payments-empty"]')).not.toBeNull();
  });
});
