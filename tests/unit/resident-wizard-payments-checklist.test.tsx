// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PaymentsStep } from "@/components/portal/resident-wizard/step-payments";
import {
  emptyAddPersonForm,
  type AddPersonForm,
} from "@/components/portal/resident-wizard/state";
import type { ResidentWizardDerived } from "@/components/portal/resident-wizard/derived";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const derived: ResidentWizardDerived = {
  roomOptions: [],
  bundleOptions: [],
  leaseTermOptions: [],
  leaseTermPresetValues: [],
  rentedByRoom: false,
  entireHome: true,
  showBundleSelect: false,
  showRoomSelect: false,
  rentalType: "standard",
  isShortTerm: false,
  isAirbnb: false,
  isMonthToMonth: false,
  applicationConfig: null,
  customQuestions: [],
  fieldEnabled: () => true,
  listingSays: null,
};

function filled(overrides: Partial<AddPersonForm> = {}): AddPersonForm {
  return {
    ...emptyAddPersonForm("resident"),
    name: "Maya Chen",
    email: "maya.chen@proton.me",
    propertyId: "prop-1",
    leaseTerm: "12 months",
    leaseTermCustomMode: true,
    moveInDate: "2026-06-01",
    moveOutDate: "2027-05-31",
    rent: "875",
    utilities: "175",
    moveInFee: "200",
    securityDeposit: "875",
    ...overrides,
  };
}

describe("Add resident Payments checklist", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-16T17:00:00.000Z"));
  });

  it("lists every charge with a paid checkbox, not a Status select", () => {
    const patch = vi.fn();
    render(<PaymentsStep form={filled()} patch={patch} derived={derived} />);

    expect(screen.getByRole("checkbox", { name: "Security deposit paid" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Move-in fee paid" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Jun 2026 paid" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Sep 2026 paid" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /status/i })).not.toBeInTheDocument();
    expect(screen.queryByText("Partial")).not.toBeInTheDocument();
  });

  it("checking a charge marks it paid", () => {
    const patch = vi.fn();
    render(<PaymentsStep form={filled({ depositPaid: false })} patch={patch} derived={derived} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Security deposit paid" }));
    expect(patch).toHaveBeenCalledWith({ depositPaid: true });
  });
});
