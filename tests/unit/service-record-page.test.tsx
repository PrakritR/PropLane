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
  it("the rail has the registry's trimmed sections (PLAN-0921-1029): Service, Vendors, Incoming payments, Outgoing payments, Communication", () => {
    render(
      <AppUiProvider>
        <ManagerWorkOrdersPanel allRows={[row()]} bucket="open" workOrderId="wo-1" listBasePath="/portal" />
      </AppUiProvider>,
    );
    const rail = screen.getByRole("navigation", { name: "Service sections" });
    const links = within(rail).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual([
      "Service",
      "Vendors",
      "Incoming payments",
      "Outgoing payments",
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

  const openMore = async () => {
    fireEvent.keyDown(document.querySelector('[data-attr="record-header-action-more"]')!, { key: "ArrowDown" });
    const menu = await screen.findByRole("menu");
    return [...menu.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent);
  };

  it("an unassigned open service shows Message, Edit, Request bids or assign, then ⋯ and the one primary: Request bids (C247: no Schedule yet)", async () => {
    render(
      <AppUiProvider>
        <ManagerWorkOrdersPanel allRows={[row({ bucket: "open" })]} bucket="open" workOrderId="wo-1" listBasePath="/portal" />
      </AppUiProvider>,
    );
    const icons = [...document.querySelectorAll('[data-attr="service-record-header-icons"] button')].filter((b) => !b.closest("[inert]")).map((b) => b.getAttribute("aria-label"));
    expect(icons).toEqual(["Message", "Edit", "Request bids or assign", "More", "Request bids"]);
    expect(document.querySelector('[data-attr="manager-service-primary"]')!.getAttribute("aria-label")).toBe("Request bids");
    // Nothing to schedule a visit for yet — offering it on an unassigned service is a dead click.
    expect(document.querySelector('[data-attr="record-header-action-schedule"]')).toBeNull();
    // Cancel service and Delete are the only red items, and they live inside the menu.
    expect(document.querySelector('[data-attr="record-header-action-delete"]')).toBeNull();
    expect(await openMore()).toEqual(["Cancel service", "Delete"]);
    for (const item of screen.getAllByRole("menuitem")) expect(item.className).toMatch(/text-red-600/);
  });

  it("an open service with a vendor assigned shows Schedule as the one primary header action (C247)", () => {
    render(
      <AppUiProvider>
        <ManagerWorkOrdersPanel
          allRows={[row({ bucket: "open", vendorId: "v-1", vendorName: "Acme Plumbing" })]}
          bucket="assigned"
          workOrderId="wo-1"
          listBasePath="/portal"
        />
      </AppUiProvider>,
    );
    expect(document.querySelector('[data-attr="manager-service-primary"]')!.getAttribute("aria-label")).toBe("Schedule");
    expect(document.querySelector('[data-attr="record-header-action-schedule"]')).toBeNull();
  });

  it("a scheduled service shows Complete as its primary (renamed from Close) and a Reschedule icon", () => {
    render(
      <AppUiProvider>
        <ManagerWorkOrdersPanel
          allRows={[row({ bucket: "scheduled", scheduled: "Sep 22", vendorId: "v-1", vendorName: "Acme Plumbing", scheduledAtIso: "2026-10-08T16:00:00.000Z" })]}
          bucket="scheduled"
          workOrderId="wo-1"
          listBasePath="/portal"
        />
      </AppUiProvider>,
    );
    expect(document.querySelector('[data-attr="manager-service-primary"]')!.getAttribute("aria-label")).toBe("Complete");
    expect(document.querySelector('[data-attr="record-header-action-close"]')).toBeNull();
    expect(screen.getByRole("button", { name: "Reschedule" })).toBeTruthy();
  });

  it("a service with a submitted bid waiting makes Compare bids the primary", () => {
    render(
      <AppUiProvider>
        <ManagerWorkOrdersPanel allRows={[row({ biddingOpen: true })]} bucket="open" workOrderId="wo-1" listBasePath="/portal" />
      </AppUiProvider>,
    );
    // No bids are loaded in this fixture, so there is nothing to compare and no primary while it waits.
    expect(document.querySelector('[data-attr="manager-service-primary"]')).toBeNull();
  });

  it("Request bids or assign opens one popup titled Request bids or assign", () => {
    render(
      <AppUiProvider>
        <ManagerWorkOrdersPanel allRows={[row()]} bucket="open" workOrderId="wo-1" listBasePath="/portal" />
      </AppUiProvider>,
    );
    fireEvent.click(document.querySelector('[data-attr="record-header-action-assign-vendor"]')!);
    expect(screen.getByRole("heading", { name: "Request bids or assign" })).toBeInTheDocument();
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
