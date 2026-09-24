// @vitest-environment jsdom
/**
 * Bed pick for a shared room (PLAN-0924-0718): same rent on every slot.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ApplicationResidentSlotPicker,
  defaultOpenResidentSlot,
} from "@/components/portal/application-resident-slot-picker";
import type { OpenResidentSlot } from "@/lib/rental-application/room-occupancy";

function slots(): OpenResidentSlot[] {
  return [
    {
      slot: 1,
      price: { slot: 1, monthlyRent: 900, utilitiesEstimate: "75", securityDeposit: "250" },
      holder: { name: "Aaron", since: new Date(2026, 8, 1) },
    },
    {
      slot: 2,
      price: { slot: 2, monthlyRent: 800, utilitiesEstimate: "75", securityDeposit: "250" },
      holder: null,
    },
  ];
}

describe("ApplicationResidentSlotPicker", () => {
  it("renders every bed with the same rent, marks a taken row disabled, and an open row selectable", () => {
    const onChange = vi.fn();
    render(<ApplicationResidentSlotPicker slots={slots()} value={2} onChange={onChange} />);

    expect(screen.getByText(/Resident 1 · \$900\/mo/)).toBeTruthy();
    expect(screen.getByText(/Resident 2 · \$900\/mo/)).toBeTruthy();
    expect(screen.queryByText(/Resident 2 · \$800\/mo/)).toBeNull();
    expect(screen.getByText(/Aaron · since Sep 1/)).toBeTruthy();
    expect(screen.getByText("Open")).toBeTruthy();

    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios[0]!.disabled).toBe(true);
    expect(radios[1]!.disabled).toBe(false);
    expect(radios[1]!.checked).toBe(true);
  });

  it("renders nothing when there are no slots (single-resident room)", () => {
    const { container } = render(
      <ApplicationResidentSlotPicker slots={[]} value={null} onChange={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("defaults to the lowest open slot", () => {
    expect(defaultOpenResidentSlot(slots())).toBe(2);
  });
});
