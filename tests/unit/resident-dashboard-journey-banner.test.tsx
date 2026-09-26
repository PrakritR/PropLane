// @vitest-environment jsdom
//
// C118: the one-journey-timeline banner, in isolation. The pure step/action
// derivation is covered by tests/unit/resident-journey-timeline.test.ts —
// this only checks the banner renders the resolved action and hides itself
// once the journey is fully complete.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ResidentJourneyBanner } from "@/components/portal/resident-dashboard";
import {
  residentJourneySteps,
  resolveResidentJourneyNextAction,
  type ResidentJourneyInput,
} from "@/lib/resident-journey-timeline";

afterEach(() => cleanup());

function bannerFor(input: ResidentJourneyInput) {
  return (
    <ResidentJourneyBanner steps={residentJourneySteps(input)} action={resolveResidentJourneyNextAction(input)} />
  );
}

const DONE_INPUT: ResidentJourneyInput = {
  hasPendingTour: false,
  applicationSubmitted: true,
  applicationApproved: true,
  leaseSignatureNeeded: false,
  leaseSigned: true,
  overdueChargeCount: 0,
  pendingChargeCount: 0,
  totalBalanceDueLabel: "$0",
};

describe("ResidentJourneyBanner", () => {
  it("renders the resolved next action as one link with one CTA", () => {
    render(bannerFor({ ...DONE_INPUT, leaseSigned: false, leaseSignatureNeeded: true }));
    const banner = screen.getByText("Sign your lease").closest('[data-attr="resident-dashboard-journey"]');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveAttribute("href", "/resident/lease");
    expect(screen.getByText("Sign lease")).toBeInTheDocument();
  });

  it("renders nothing once the journey has no next step", () => {
    const { container } = render(bannerFor(DONE_INPUT));
    expect(container.querySelector('[data-attr="resident-dashboard-journey"]')).not.toBeInTheDocument();
  });

  it("renders all four step labels in the trail", () => {
    render(bannerFor({ ...DONE_INPUT, applicationApproved: false }));
    for (const label of ["Tour", "Application", "Lease", "Payments"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });
});
