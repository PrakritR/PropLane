// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ManagerPropertyLeasePanel, leaseListRowCount } from "@/components/portal/pro-property-lease-panel";
import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

vi.mock("@/components/portal/property-lease-form-modal", () => ({
  PropertyLeaseFormModal: () => null,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/portal/properties/all/mgr-house-1/lease",
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

    // Tabs: Long-term leases (with its count); no Default tab, and the Applications tab is never here.
    expect(screen.getByRole("button", { name: /^Long-term leases/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Default/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /Applications/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Lease settings" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit lease" })).toBeNull();

    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.keyDown(screen.getAllByRole("button", { name: "Actions for Long-term lease" })[0]!, { key: "ArrowDown" });
    expect(await screen.findByRole("menuitem", { name: "Edit lease" })).toBeTruthy();
    expect(await screen.findByRole("menuitem", { name: "Delete" })).toBeTruthy();
    expect(document.querySelector('[data-attr="record-row-facts"]')).toBeTruthy();
    // Round 4: a real lease is a card row with a square icon tile, like every other property tab.
    expect(document.querySelector('[data-attr="property-lease-row-tpl-1"]')?.closest(".portal-property-row")).toBeTruthy();
    expect(document.querySelectorAll('[data-slot="portal-row-icon-tile"]').length).toBeGreaterThan(0);
  });

  it("counts exactly the rows it shows; a lease-less property shows no placeholder rows, its presets live in the round + menu", async () => {
    const sub = createDefaultListingSubmission();
    const onUpdated = vi.fn();
    render(
      <AppUiProvider>
        <ManagerPropertyLeasePanel
          sub={sub}
          saveTarget={{ mode: "listing", saveId: "mgr-house-1" }}
          managerUserId="mgr-1"
          settingsPropertyId="mgr-house-1"
          onUpdated={onUpdated}
          showToast={() => {}}
        />
      </AppUiProvider>,
    );
    expect(document.querySelectorAll('[data-attr^="property-lease-empty-type-"]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-attr^="property-lease-row-"]')).toHaveLength(0);
    // The header count is exactly the rows shown: none.
    const link = screen.getByRole("button", { name: /^Long-term leases/ });
    expect(link.textContent).toMatch(/Long-term leases\s*0/);
    // No separate Quick add row: the open tab's stay presets sit in the round + menu, after the blank item.
    expect(document.querySelector('[data-attr="property-lease-quick-add"]')).toBeNull();
    fireEvent.keyDown(screen.getByRole("button", { name: "Add lease" }), { key: "ArrowDown" });
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["Add lease", "Long-term lease"]);
  });

  it("leaseListRowCount: exactly the leases the property has", () => {
    expect(leaseListRowCount([])).toBe(0);
    expect(leaseListRowCount([{ listingSeedKey: "primary" }])).toBe(1);
    expect(leaseListRowCount([{ listingSeedKey: "primary" }, { listingSeedKey: "primary" }, {}])).toBe(3);
  });
});
