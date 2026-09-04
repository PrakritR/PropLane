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
  /**
   * Selection first, then the action.
   *
   * This tab used to show an always-on "Edit lease" button and no way to pick a
   * row. It is now the house convention every list follows: a checkbox on each
   * row, and the action in a floating dock that exists only while something is
   * selected — so the button always says what it will act on. Delete stays in
   * the editor, which is why the dock carries Edit alone.
   */
  it("selects a lease with a checkbox, then offers Edit lease in the dock", () => {
    // A property with a real lease template. The default submission has NONE —
    // an empty list is a legitimate state — so a test built on it renders no
    // rows and can assert nothing about selecting one.
    const sub = {
      ...createDefaultListingSubmission(),
      propertyLeaseTemplates: [
        {
          id: "tpl-1",
          kind: "long_term",
          label: "Long-term lease",
          leaseConfigMode: "standard",
          leaseCustomKind: "terms",
          customLeaseTerms: "",
          leaseTemplateDocUrl: null,
          leaseTemplateDocName: "",
        },
      ],
    } as ReturnType<typeof createDefaultListingSubmission>;
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

    // Nothing selected: Settings is the only action, and the dock is absent.
    expect(screen.getByRole("button", { name: "Settings" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit lease" })).toBeNull();

    const boxes = screen.getAllByRole("checkbox");
    expect(boxes.length).toBeGreaterThan(0);
    fireEvent.click(boxes[0]!);

    // One row selected: the dock appears carrying Edit lease, and only that.
    expect(screen.getByRole("button", { name: "Edit lease" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByTestId("lease-settings-modal")).toBeTruthy();
  });
});
