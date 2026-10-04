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

    expect(screen.getByRole("link", { name: /^Leases/ })).toBeTruthy();
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

  it("counts exactly the rows it shows and gives a lease-less type a ⋯ menu, not a round +", async () => {
    const sub = createDefaultListingSubmission();
    render(
      <AppUiProvider>
        <ManagerPropertyLeasePanel
          sub={sub}
          saveTarget={{ mode: "listing", saveId: "mgr-house-1" }}
          managerUserId="mgr-1"
          settingsPropertyId="mgr-house-1"
          onUpdated={() => {}}
          showToast={() => {}}
        />
      </AppUiProvider>,
    );
    const emptyRows = document.querySelectorAll('[data-attr^="property-lease-empty-type-"]');
    expect(emptyRows.length).toBeGreaterThan(0);
    // The header count equals the rows on screen (it used to read "Leases 0" over two placeholder rows).
    const link = screen.getByRole("link", { name: /^Leases/ });
    expect(link.textContent).toContain(String(emptyRows.length));
    expect(link.textContent).not.toMatch(/Leases\s*0/);
    // No per-row round +; the standard ⋯ menu carries the two ways to add.
    expect(document.querySelector('[data-attr^="property-lease-add-type-"]')).toBeNull();
    const first = emptyRows[0]!;
    expect(first.closest(".portal-property-row")).toBeTruthy();
    fireEvent.keyDown(within(first.closest(".portal-property-row") as HTMLElement).getByRole("button", { name: /^Actions for/ }), { key: "ArrowDown" });
    expect(await screen.findByRole("menuitem", { name: "Add PropLane standard" })).toBeTruthy();
    expect(await screen.findByRole("menuitem", { name: "Upload a PDF" })).toBeTruthy();
  });

  it("leaseListRowCount: one row per offered type (placeholder included) plus leases outside those types", () => {
    expect(leaseListRowCount([], ["primary", "short-term"])).toBe(2);
    expect(leaseListRowCount([{ listingSeedKey: "primary" }], ["primary", "short-term"])).toBe(2);
    expect(leaseListRowCount([{ listingSeedKey: "primary" }, { listingSeedKey: "primary" }], ["primary", "short-term"])).toBe(3);
    expect(leaseListRowCount([{ listingSeedKey: "primary" }, {}], ["primary"])).toBe(2);
  });
});
