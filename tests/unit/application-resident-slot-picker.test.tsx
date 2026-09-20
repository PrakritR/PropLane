// @vitest-environment jsdom
/**
 * The "Rent for this resident" picker (PLAN-0920-0631): one radio row per
 * slot, disabled and labelled "who + since" when taken, selectable and
 * labelled "Open" otherwise, and defaulting to the lowest open slot.
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
  it("renders every slot's rent, marks a taken row disabled with who holds it, and an open row selectable", () => {
    const onChange = vi.fn();
    render(<ApplicationResidentSlotPicker slots={slots()} value={2} onChange={onChange} />);

    expect(screen.getByText(/Resident 1 · \$900\/mo/)).toBeTruthy();
    expect(screen.getByText(/Resident 2 · \$800\/mo/)).toBeTruthy();
    expect(screen.getByText(/Aaron · since Sep 1/)).toBeTruthy();
    expect(screen.getByText("Open")).toBeTruthy();

    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios[0]!.disabled).toBe(true);
    expect(radios[1]!.disabled).toBe(false);
    expect(radios[1]!.checked).toBe(true);
  });

  it("renders nothing when there are no slots (the room does not price per resident)", () => {
    const { container } = render(
      <ApplicationResidentSlotPicker slots={[]} value={null} onChange={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("defaults to the lowest OPEN slot, not merely the lowest slot", () => {
    expect(defaultOpenResidentSlot(slots())).toBe(2);
    // Every slot taken: fall back to the first slot rather than null, so the
    // manager still sees a pick even though approval will refuse it.
    const allTaken = slots().map((s) => ({ ...s, holder: { name: "Someone", since: new Date() } }));
    expect(defaultOpenResidentSlot(allTaken)).toBe(1);
    expect(defaultOpenResidentSlot([])).toBeNull();
  });
});
