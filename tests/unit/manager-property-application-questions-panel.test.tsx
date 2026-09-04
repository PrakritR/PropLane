// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ManagerPropertyApplicationQuestionsPanel } from "@/components/portal/pro-property-application-questions-panel";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import { addApplicationTemplateFromSeed } from "@/lib/property-application-template-sync";

vi.mock("@/components/portal/pro-application-questions-editor-modal", () => ({
  ManagerApplicationQuestionsEditorModal: () => null,
}));
vi.mock("@/components/portal/pro-portal-settings-modal", () => ({
  ProPortalSettingsModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="application-settings-modal" /> : null,
}));

describe("ManagerPropertyApplicationQuestionsPanel", () => {
  it("property tab shows checkboxes and Settings only — not Edit application", () => {
    const sub = addApplicationTemplateFromSeed(
      addApplicationTemplateFromSeed(createDefaultListingSubmission(), "standard"),
      "short-term",
    );
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

    expect(screen.queryByRole("button", { name: "Edit application" })).toBeNull();
    expect(screen.getByRole("button", { name: "Settings" })).toBeTruthy();
    expect(screen.queryAllByRole("checkbox").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByTestId("application-settings-modal")).toBeTruthy();
  });

  it("Edit application modal keeps checkbox selection", () => {
    const sub = addApplicationTemplateFromSeed(createDefaultListingSubmission(), "standard");
    render(
      <ManagerPropertyApplicationQuestionsPanel
        sub={sub}
        saveTarget={{ mode: "listing", saveId: "mgr-house-1" }}
        managerUserId="mgr-1"
        onUpdated={() => {}}
        showToast={() => {}}
        onBulkActionsChange={() => {}}
      />,
    );

    expect(screen.queryAllByRole("checkbox").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Edit application" })).toBeNull();
  });
});
