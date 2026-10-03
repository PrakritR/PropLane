// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";

vi.mock("@/lib/demo-admin-property-inventory", () => ({
  publishManagerPropertyDraftToServer: vi.fn(),
  saveManagerPropertyDraftToServer: vi.fn(),
}));
vi.mock("@/lib/demo-property-pipeline", () => ({ submitManagerPendingPropertyToServer: vi.fn() }));

import {
  createDefaultListingSubmission,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import { renderListingPricing } from "./helpers/listing-pricing-workspace-harness";

afterEach(() => cleanup());

function seededRoom(room: Partial<ManagerListingSubmissionV1["rooms"][number]>): ManagerListingSubmissionV1 {
  const base = createDefaultListingSubmission();
  return {
    ...base,
    allowedLeaseTerms: ["Long-term"],
    rooms: [{ id: "r1", name: "Room A", monthlyRent: 1200, utilitiesEstimate: "150", ...room }],
  } as ManagerListingSubmissionV1;
}

function openRoomCard() {
  fireEvent.click(screen.getByRole("button", { name: "Open Room A prices" }));
}

describe("Room card — Rent formats like Utilities and Deposit (PRP-499)", () => {
  it("trims stray whitespace on Rent exactly like it already does on Utilities and Deposit", () => {
    renderListingPricing({
      initial: seededRoom({
        monthlyRent: " 1200" as unknown as number,
        utilitiesEstimate: " 150",
        securityDeposit: " 900",
      }),
    });
    openRoomCard();

    const rent = screen.getByLabelText(/Room A rent on/i) as HTMLInputElement;
    const util = screen.getByLabelText(/Room A utilities on/i) as HTMLInputElement;
    const dep = screen.getByLabelText(/Room A deposit on/i) as HTMLInputElement;

    expect(rent.value).toBe("1200");
    expect(util.value).toBe("150");
    expect(dep.value).toBe("900");
  });

  it("still shows a clean whole-number Rent with no formatting regression", () => {
    renderListingPricing({
      initial: seededRoom({ monthlyRent: 1450, utilitiesEstimate: "120", securityDeposit: "1000" }),
    });
    openRoomCard();
    expect((screen.getByLabelText(/Room A rent on/i) as HTMLInputElement).value).toBe("1450");
  });

  it("shows an empty Rent field (not '0') when no rent has been set yet", () => {
    renderListingPricing({ initial: seededRoom({ monthlyRent: 0, utilitiesEstimate: "", securityDeposit: "" }) });
    openRoomCard();
    expect((screen.getByLabelText(/Room A rent on/i) as HTMLInputElement).value).toBe("");
  });
});
