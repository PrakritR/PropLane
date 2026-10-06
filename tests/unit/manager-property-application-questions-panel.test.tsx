// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/portal/properties/all/mgr-house-1/application",
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(() => {
  cleanup();
});

describe("ManagerPropertyApplicationQuestionsPanel", () => {
  it("property tab shows per-template action menus under the Long term · Short term tabs", () => {
    // Short term is offered, so its default application exists (a long-term-only property is never given one).
    const bothStays = { ...createDefaultListingSubmission(), allowedLeaseTerms: ["Long-term", "Short-Term Stay"], shortTermRentalsAllowed: true };
    const sub = addApplicationTemplateFromSeed(addApplicationTemplateFromSeed(bothStays, "standard"), "short-term");
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
    expect(screen.queryByRole("button", { name: "Application automation" })).toBeNull();
    // Tabs: Long term · Short term. There is no Default tab: a stay's default is a row in its list.
    expect(screen.getByRole("button", { name: /^Long term/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Short term/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Default/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /Leases/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Short term/ }));
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getAllByRole("button", { name: /^Actions for/ }).length).toBeGreaterThan(0);
    expect(document.querySelector('[data-attr="record-row-facts"]')).toBeTruthy();
    // Round 4: the same card row as every other property tab — a square icon tile before the title.
    const tiles = document.querySelectorAll('[data-slot="portal-row-icon-tile"]');
    expect(tiles.length).toBe(screen.getAllByRole("button", { name: /^Actions for/ }).length);
    expect(document.querySelector('[data-attr^="property-application-row-"]')?.closest(".portal-property-row")).toBeTruthy();
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

    expect(document.querySelectorAll("input[type='checkbox'][aria-label^='Select ']").length).toBeGreaterThan(0);
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
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Actions for Long-term application" })).toBeTruthy();
    });
    fireEvent.keyDown(screen.getByRole("button", { name: "Actions for Long-term application" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
    await waitFor(() => expect(screen.getByTestId("application-editor-modal")).toBeTruthy());
    expect(persistSubmission).not.toHaveBeenCalled();
  });
});
