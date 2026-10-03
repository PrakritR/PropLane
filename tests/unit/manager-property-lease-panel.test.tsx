// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ManagerPropertyLeasePanel } from "@/components/portal/pro-property-lease-panel";
import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

vi.mock("@/components/portal/property-lease-form-modal", () => ({
  PropertyLeaseFormModal: () => null,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/portal/properties/all/mgr-house-1",
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(() => {
  cleanup();
});

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
      <AppUiProvider>
        <ManagerPropertyLeasePanel
          sub={sub}
          saveTarget={{ mode: "listing", saveId: "mgr-house-1" }}
          managerUserId="mgr-1"
          settingsPropertyId="mgr-house-1"
          settingsPropertyLabel="Ash Flats 6"
          onUpdated={() => {}}
          showToast={() => {}}
        />
      </AppUiProvider>,
    );

    // Record editing appears only inside that record’s menu.
    expect(screen.getByRole("button", { name: "Lease settings" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit lease" })).toBeNull();

    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.keyDown(screen.getByRole("button", { name: "Actions for Long-term lease" }), { key: "ArrowDown" });
    expect(await screen.findByRole("menuitem", { name: "Edit lease" })).toBeTruthy();
    expect(await screen.findByRole("menuitem", { name: "Delete" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    fireEvent.click(screen.getByRole("button", { name: "Lease settings" }));
    expect(await screen.findByRole("dialog", { name: "Lease settings" })).toBeTruthy();
  });
});
