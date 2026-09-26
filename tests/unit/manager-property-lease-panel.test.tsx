// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ManagerPropertyLeasePanel } from "@/components/portal/pro-property-lease-panel";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

vi.mock("@/components/portal/property-lease-form-modal", () => ({
  PropertyLeaseFormModal: () => null,
}));
// C228: the property page's own automation sheet is gone — the gear now
// navigates to Settings -> Forms instead, which needs the app router mounted.
const routerPush = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush }),
  usePathname: () => "/portal/properties/all/mgr-house-1",
}));

describe("ManagerPropertyLeasePanel", () => {
  it("offers lease editing from that row’s menu", async () => {
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

    // Record editing appears only inside that record’s menu.
    expect(screen.getByRole("button", { name: "Lease automation" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit lease" })).toBeNull();

    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.keyDown(screen.getByRole("button", { name: "Actions for Long-term lease" }), { key: "ArrowDown" });
    expect(await screen.findByRole("menuitem", { name: "Edit lease" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /delete/i })).toBeNull();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    // C228: the gear no longer opens a local automation sheet — it jumps to
    // Settings -> Forms, where this lease's Automation block now lives.
    fireEvent.click(screen.getByRole("button", { name: "Lease automation" }));
    expect(routerPush).toHaveBeenCalledWith("/portal/profile?tab=forms");
  });
});
