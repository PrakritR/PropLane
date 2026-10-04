// @vitest-environment jsdom
//
// Every list tab on the SERVICE record and the VENDOR record opens with the standard list header band
// (tabs with counts, search, the round + where a create exists) and puts rows, or the one standard
// empty card, UNDER it - never a bare centered card at the top of the tab.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/services/work-orders/open/wo-1",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("@/hooks/use-manager-user-id", () => ({ useManagerUserId: () => ({ userId: "mgr-1", email: "mgr@example.com", ready: true }) }));
vi.mock("@/hooks/use-work-assignment-directory", () => ({ useWorkAssignmentDirectory: () => ({ teamMembers: [{ userId: "mgr-1", name: "Me" }], vendors: [] }) }));
vi.mock("@/lib/manager-vendors-storage", () => ({
  MANAGER_VENDORS_EVENT: "manager-vendors-changed",
  readActiveManagerVendorRows: () => [],
  syncManagerVendorsFromServer: () => Promise.resolve(),
}));
vi.mock("@/lib/manager-work-orders-storage", () => ({
  deleteManagerWorkOrderRow: vi.fn(() => true),
  updateManagerWorkOrder: vi.fn(),
  syncManagerWorkOrdersFromServer: () => Promise.resolve(),
}));
vi.mock("@/components/portal/record-communication-section", () => ({ RecordCommunicationSection: () => <div data-attr="mock-thread" /> }));

import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { ManagerWorkOrdersPanel } from "@/components/portal/pro-work-orders-panel";

afterEach(() => {
  cleanup();
});

const wo = (over: Partial<DemoManagerWorkOrderRow> = {}): DemoManagerWorkOrderRow => ({
  id: "wo-1", propertyName: "12 Maple St", unit: "1A", title: "Fix sink", priority: "Medium", status: "Open", bucket: "open",
  description: "", scheduled: "", cost: "", ...over,
});

const renderTab = (tab: string, row = wo()) =>
  render(
    <AppUiProvider>
      <ManagerWorkOrdersPanel allRows={[row]} bucket={row.bucket} workOrderId={row.id} serviceDetailTab={tab as never} listBasePath="/portal" />
    </AppUiProvider>,
  );

/** The band: a command-variant control stack holding tabs, with its tab labels (and counts) in order. */
const bandTabs = (root: string) => {
  const band = document.querySelector(`[data-attr="${root}"]`)!;
  expect(band, `${root} renders`).not.toBeNull();
  const buttons = [...band.querySelectorAll<HTMLElement>(`[data-attr^="${root}-tab-"]`)];
  return buttons.map((b) => (b.textContent ?? "").replace(/\s*\d+$/, "").trim());
};
const underBand = (root: string) => {
  const band = document.querySelector(`[data-attr="${root}"]`)!;
  const first = band.firstElementChild!;
  // The tab content starts with the band (its search field is inside the first child), not a bare card.
  expect(first.querySelector("input[type='search'], input")).not.toBeNull();
};

describe("service record tabs open with the standard band", () => {
  it("Incoming payments: Pending · Overdue · Paid, search, and the empty card under the band", () => {
    renderTab("incoming-payments");
    expect(bandTabs("service-incoming-payments")).toEqual(["Pending", "Overdue", "Paid"]);
    underBand("service-incoming-payments");
    expect(screen.getByPlaceholderText("Search charges")).toBeTruthy();
    expect(document.querySelector('[data-attr="portal-list-empty-card"]')).not.toBeNull();
    expect(screen.queryByText("No charges for this service")).toBeNull();
  });

  it("Outgoing payments: To pay · Paid, search, empty card under the band", () => {
    renderTab("outgoing-payments");
    expect(bandTabs("work-order-outgoing-payments")).toEqual(["To pay", "Paid"]);
    underBand("work-order-outgoing-payments");
    expect(screen.getByPlaceholderText("Search payments")).toBeTruthy();
    expect(document.querySelector('[data-attr="portal-list-empty-card"]')).not.toBeNull();
    expect(screen.queryByText("Nothing to pay on this service")).toBeNull();
  });

  it("Vendor & schedule: Requested · Bids · Approved, search, the round + to request vendors, stage card under the band", () => {
    renderTab("vendor-schedule");
    expect(bandTabs("service-vendor-cycle")).toEqual(["Requested", "Bids", "Approved"]);
    underBand("service-vendor-cycle");
    expect(screen.getByPlaceholderText("Search vendors")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Request more vendors" })).toBeTruthy();
    const band = document.querySelector('[data-attr="service-vendor-cycle"]')!;
    // Band first (it holds the search), then the stage card with Assign, then the list surface.
    const stage = band.querySelector('[data-attr="service-stage-card"]')!;
    expect(stage).not.toBeNull();
    expect(band.firstElementChild!.contains(screen.getByPlaceholderText("Search vendors"))).toBe(true);
    expect(band.firstElementChild!.contains(stage)).toBe(false);
    expect(within(stage as HTMLElement).getByText("Pending")).toBeTruthy();
    expect(document.body.textContent).not.toContain("No vendors on this service");
  });

  it("Communication keeps the thread pane and Service keeps the overview cards", () => {
    renderTab("communication");
    expect(document.querySelector('[data-attr="mock-thread"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="service-communication-pane"]')).not.toBeNull();
    cleanup();
    renderTab("service");
    expect(document.querySelector('[data-attr="record-overview-card-request"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="service-incoming-payments"]')).toBeNull();
  });

  it("an Overdue charge turns the Overdue tab red (alert) only while its count is above zero", () => {
    const src = read("src/components/portal/service-incoming-payments-list.tsx");
    expect(src).toContain('alert: t.id === "overdue" && counts.overdue > 0');
  });
});

describe("one band component, no second implementation", () => {
  it("every list tab composes RecordListBand, which composes the Payments header (PortalListControlStack) and PortalRecordListSurface", () => {
    const band = read("src/components/portal/record-list-band.tsx");
    expect(band).toContain("PortalListControlStack");
    expect(band).toContain("PortalRecordListSurface");
    expect(band).toContain('appearance="command"');
    for (const file of [
      "service-incoming-payments-list.tsx",
      "service-outgoing-payments-list.tsx",
      "service-vendor-cycle-section.tsx",
      "vendor-record-services-tab.tsx",
    ]) {
      expect(read(`src/components/portal/${file}`), file).toContain("<RecordListBand");
    }
  });

  it("the vendor record's Outgoing payments (To pay · Scheduled · Paid) and Reviews tabs use the same control stack", () => {
    expect(read("src/components/portal/manager-outgoing-invoices-panel.tsx")).toContain('<PortalListControlStack variant="command"');
    expect(read("src/components/portal/pro-vendor-detail.tsx")).toContain("PortalListControlStack");
  });

  it("no tab opens on a bare centered card", () => {
    const outgoing = read("src/components/portal/pro-work-orders-panel.tsx");
    expect(outgoing).not.toContain("Nothing to pay on this service");
    expect(read("src/components/portal/service-incoming-payments-list.tsx")).not.toContain("No charges for this service");
  });
});
