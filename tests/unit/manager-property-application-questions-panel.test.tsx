// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ManagerPropertyApplicationQuestionsPanel } from "@/components/portal/pro-property-application-questions-panel";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import { addApplicationTemplateFromSeed } from "@/lib/property-application-template-sync";

const persistSubmission = vi.hoisted(() => vi.fn());
vi.mock("@/lib/manager-property-save-target", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/manager-property-save-target")>()),
  persistManagerListingSubmissionOnServer: persistSubmission,
}));
vi.mock("@/components/portal/pro-application-questions-editor-modal", () => ({
  ManagerApplicationQuestionsEditorModal: () => <div data-testid="application-editor-modal" />,
}));
// C228: the property page's own automation sheet is gone — the gear now
// navigates to Settings -> Forms instead, which needs the app router mounted.
const routerPush = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush }),
  usePathname: () => "/portal/properties/all/mgr-house-1",
}));

describe("ManagerPropertyApplicationQuestionsPanel", () => {
  it("property tab shows per-template action menus and Application automation", () => {
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
    expect(screen.getByRole("button", { name: "Application automation" })).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getAllByRole("button", { name: /^Actions for/ }).length).toBeGreaterThan(0);

    // C228: the gear no longer opens a local automation sheet — it jumps to
    // Settings -> Forms, where this application form's Automation block now lives.
    fireEvent.click(screen.getByRole("button", { name: "Application automation" }));
    expect(routerPush).toHaveBeenCalledWith("/portal/profile?tab=forms");
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

  it("opening a fallback application in bulk does not overwrite selected properties", async () => {
    persistSubmission.mockClear();
    render(
      <ManagerPropertyApplicationQuestionsPanel
        sub={createDefaultListingSubmission()}
        saveTarget={{ mode: "listing", saveId: "mgr-house-1" }}
        propertyIds={["mgr-house-1", "mgr-house-2"]}
        managerUserId="mgr-1"
        onUpdated={() => {}}
        showToast={() => {}}
      />,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "Actions for Long-term application" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
    expect(screen.getByTestId("application-editor-modal")).toBeTruthy();
    expect(persistSubmission).not.toHaveBeenCalled();
  });
});
