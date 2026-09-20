// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { LeaseAmendMoveOutModal } from "@/components/portal/lease-amend-move-out-modal";
import { LEASE_TERM_CHOICES } from "@/lib/rental-application/lease-terms";

afterEach(() => {
  cleanup();
});

describe("New terms sheet", () => {
  it("opens on Term / Starts / Monthly rent and Create and send", async () => {
    const term = LEASE_TERM_CHOICES[0] ?? "Month-to-Month";
    render(
      <AppUiProvider>
        <LeaseAmendMoveOutModal
          open
          variant="new-terms"
          onClose={() => {}}
          currentEnd="2027-08-31"
          leaseStart="2026-09-01"
          propertyId="prop-1"
          checkUrl="/api/manager/amend-lease"
          amendUrl="/api/manager/amend-lease"
          amendBody={{ leaseId: "lease-1" }}
          renew={{
            leaseId: "lease-1",
            currentTerm: term,
            currentRentLabel: "$1,200",
            renewUrl: "/api/manager/amend-lease",
            listingRentLabel: "$1,100",
          }}
          onSuccess={() => {}}
        />
      </AppUiProvider>,
    );

    await waitFor(() => expect(screen.getByRole("heading", { name: "New terms" })).toBeTruthy());
    expect(screen.getByText("Term")).toBeTruthy();
    expect(screen.getByText("Starts")).toBeTruthy();
    expect(screen.getAllByText("Monthly rent").length).toBeGreaterThan(0);
    expect(screen.getByText("House listing")).toBeTruthy();
    expect(screen.getByText("$1,100")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create and send" })).toBeTruthy();
    expect(screen.queryByText("Current move-out date")).toBeNull();
    expect(screen.queryByText("Change renewal option")).toBeNull();
    expect(screen.queryByText("Leave blank to keep current rent")).toBeNull();
  });
});
