// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";

const navigate = vi.fn();
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => navigate }));
vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "mgr-1", email: "mgr@example.com", ready: true }),
}));
vi.mock("@/hooks/use-work-assignment-directory", () => ({
  useWorkAssignmentDirectory: () => ({ teamMembers: [], vendors: [] }),
}));
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

import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { ManagerWorkOrdersPanel } from "@/components/portal/pro-work-orders-panel";

afterEach(() => {
  cleanup();
  navigate.mockClear();
});

function row(overrides: Partial<DemoManagerWorkOrderRow> = {}): DemoManagerWorkOrderRow {
  return {
    id: "wo-1",
    propertyName: "12 Maple St",
    unit: "1A",
    title: "Fix sink",
    priority: "Medium",
    status: "Open",
    bucket: "open",
    description: "Leaking under the sink",
    scheduled: "",
    cost: "",
    ...overrides,
  };
}

describe("service record page (work order)", () => {
  it("the rail has the registry's trimmed sections (PLAN-0921-1029): Overview, Vendor & schedule, Photos, Payments, Communication", () => {
    render(
      <AppUiProvider>
        <ManagerWorkOrdersPanel allRows={[row()]} bucket="open" workOrderId="wo-1" listBasePath="/portal" />
      </AppUiProvider>,
    );
    const rail = screen.getByRole("navigation", { name: "Service sections" });
    const links = within(rail).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual([
      "Overview",
      "Vendor & schedule",
      "Photos",
      "Payments",
      "Communication",
    ]);
  });

  it("copy says service, never work order", () => {
    render(
      <AppUiProvider>
        <ManagerWorkOrdersPanel allRows={[row()]} bucket="open" workOrderId="wo-1" listBasePath="/portal" />
      </AppUiProvider>,
    );
    expect(document.body.textContent).not.toMatch(/work order/i);
  });

  it("an unassigned open work order shows Assign vendor and Delete, but not Schedule (C247)", () => {
    render(
      <AppUiProvider>
        <ManagerWorkOrdersPanel allRows={[row({ bucket: "open" })]} bucket="open" workOrderId="wo-1" listBasePath="/portal" />
      </AppUiProvider>,
    );
    expect(document.querySelector('[data-attr="record-header-action-assign-vendor"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="record-header-action-delete"]')).not.toBeNull();
    // Nothing to schedule a visit for yet — offering it on an unassigned service is a dead click.
    expect(document.querySelector('[data-attr="record-header-action-schedule"]')).toBeNull();
    // Nothing to close yet — dropped rather than shown as a dead "Coming soon".
    expect(document.querySelector('[data-attr="record-header-action-close"]')).toBeNull();
  });

  it("an open work order with a vendor assigned shows Schedule (C247)", () => {
    render(
      <AppUiProvider>
        <ManagerWorkOrdersPanel
          allRows={[row({ bucket: "open", vendorId: "v-1", vendorName: "Acme Plumbing" })]}
          bucket="open"
          workOrderId="wo-1"
          listBasePath="/portal"
        />
      </AppUiProvider>,
    );
    expect(document.querySelector('[data-attr="record-header-action-schedule"]')).not.toBeNull();
  });

  it("a scheduled work order shows Close (mark complete) in the header", () => {
    render(
      <AppUiProvider>
        <ManagerWorkOrdersPanel
          allRows={[row({ bucket: "scheduled", scheduled: "Sep 22" })]}
          bucket="scheduled"
          workOrderId="wo-1"
          listBasePath="/portal"
        />
      </AppUiProvider>,
    );
    expect(document.querySelector('[data-attr="record-header-action-close"]')).not.toBeNull();
  });

  it("Assign vendor opens a sheet rather than an inline picker", () => {
    render(
      <AppUiProvider>
        <ManagerWorkOrdersPanel allRows={[row()]} bucket="open" workOrderId="wo-1" listBasePath="/portal" />
      </AppUiProvider>,
    );
    fireEvent.click(document.querySelector('[data-attr="record-header-action-assign-vendor"]')!);
    expect(screen.getByText("Assign to")).toBeInTheDocument();
  });

  it("never shows Coming soon on the record page", () => {
    render(
      <AppUiProvider>
        <ManagerWorkOrdersPanel allRows={[row()]} bucket="open" workOrderId="wo-1" listBasePath="/portal" />
      </AppUiProvider>,
    );
    expect(document.body.textContent).not.toMatch(/Coming soon/i);
  });

  it("shows 'Service not found' for an id that resolves to nothing", () => {
    render(
      <AppUiProvider>
        <ManagerWorkOrdersPanel allRows={[row()]} bucket="open" workOrderId="does-not-exist" listBasePath="/portal" />
      </AppUiProvider>,
    );
    expect(screen.getByText("Service not found.")).toBeTruthy();
  });
});
