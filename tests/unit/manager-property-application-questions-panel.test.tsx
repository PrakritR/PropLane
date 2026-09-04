// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ManagerPropertyApplicationQuestionsPanel } from "@/components/portal/manager-property-application-questions-panel";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

vi.mock("@/components/portal/manager-application-questions-editor-modal", () => ({
  ManagerApplicationQuestionsEditorModal: () => null,
}));
vi.mock("@/components/portal/manager-portal-settings-modal", () => ({
  ManagerPortalSettingsModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="application-settings-modal" /> : null,
}));

describe("ManagerPropertyApplicationQuestionsPanel", () => {
  it("shows a read-only list with Edit application and Settings actions", () => {
    const sub = createDefaultListingSubmission();
    render(
      <ManagerPropertyApplicationQuestionsPanel
        sub={sub}
        saveTarget={{ mode: "listing", saveId: "mgr-house-1" }}
        managerUserId="mgr-1"
        settingsPropertyId="mgr-house-1"
        settingsPropertyLabel="Ash Flats 6"
        onUpdated={() => {}}
        showToast={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: "Edit application" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Settings" })).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByTestId("application-settings-modal")).toBeTruthy();
  });
});
