// @vitest-environment jsdom
//
// C251: the Outgoing payments list gives no due-date urgency signal today —
// an overdue vendor payment's due-date fact looks identical to a pending
// one's. This asserts the overdue row's due fact carries the same "text-danger"
// cue an overdue resident charge already gets, and that a pending row does not.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { DemoManagerOutgoingPaymentRow } from "@/data/demo-portal";
import { ManagerOutgoingPaymentsPanel } from "@/components/portal/pro-outgoing-payments-panel";

vi.mock("@/lib/portal-nav-client", () => ({
  usePortalNavigate: () => vi.fn(),
}));

vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => vi.fn(async () => true),
  useAppUi: () => ({ showToast: vi.fn() }),
}));

afterEach(() => {
  cleanup();
});

function sampleRow(overrides: Partial<DemoManagerOutgoingPaymentRow> = {}): DemoManagerOutgoingPaymentRow {
  return {
    id: "pay-1",
    propertyName: "The Magnolia",
    categoryLabel: "Repair",
    payeeLabel: "Brightline Plumbing",
    chargeTitle: "Closet door off track",
    amountLabel: "$132.00",
    dueDate: "2026-06-01",
    bucket: "pending",
    statusLabel: "Approved",
    ...overrides,
  };
}

describe("Outgoing payments due-date urgency (C251)", () => {
  it("colors an overdue row's due fact — a plain fact, never a pill", () => {
    render(
      <ManagerOutgoingPaymentsPanel
        rows={[sampleRow({ bucket: "overdue" })]}
        activeBucket="overdue"
        groupMode="house"
      />,
    );
    const dueText = document.body.textContent ?? "";
    expect(dueText).toContain("Jun 1, 2026");
    const dangerEl = document.querySelector(".text-danger");
    expect(dangerEl).toBeTruthy();
    expect(dangerEl?.textContent ?? "").toContain("Jun 1, 2026");
    // Still no badge/pill element introduced.
    expect(document.querySelector('[class*="badge" i]')).toBeNull();
  });

  it("leaves a pending row's due fact uncolored", () => {
    render(
      <ManagerOutgoingPaymentsPanel
        rows={[sampleRow({ bucket: "pending" })]}
        activeBucket="pending"
        groupMode="house"
      />,
    );
    expect(document.querySelector(".text-danger")).toBeNull();
  });
});
