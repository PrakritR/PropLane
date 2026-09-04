// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ManagerPropertyLeasePanel } from "@/components/portal/pro-property-lease-panel";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

vi.mock("@/components/portal/property-lease-form-modal", () => ({
  PropertyLeaseFormModal: () => null,
}));
vi.mock("@/components/portal/pro-portal-settings-modal", () => ({
  ProPortalSettingsModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="lease-settings-modal" /> : null,
}));

describe("ManagerPropertyLeasePanel", () => {
  it("shows a read-only list with Edit lease and Settings actions", () => {
    const sub = createDefaultListingSubmission();
    render(
      <ManagerPropertyLeasePanel
        sub={sub}
        saveTarget={{ mode: "listing", saveId: "mgr-house-1" }}
        managerUserId="mgr-1"
        settingsPropertyId="mgr-house-1"
        settingsPropertyLabel="Ash Flats 6"
        onUpdated={() => {}}
        showToast={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: "Edit lease" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Settings" })).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByTestId("lease-settings-modal")).toBeTruthy();
  });
});
