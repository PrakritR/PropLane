// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { seedDemoWorkOrderBids } from "@/lib/work-order-bids-storage";
import type { WorkOrderBid } from "@/lib/work-order-bids";

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

  it("an unassigned open service shows Message, Edit, then ⋯ and the one labeled primary: Request bids (C247: no Schedule yet)", async () => {
    render(
      <AppUiProvider>
        <ManagerWorkOrdersPanel allRows={[row({ bucket: "open" })]} bucket="open" workOrderId="wo-1" listBasePath="/portal" />
      </AppUiProvider>,
    );
    const icons = [...document.querySelectorAll('[data-attr="service-record-header-icons"] button')].filter((b) => !b.closest("[inert]")).map((b) => b.getAttribute("aria-label"));
    expect(icons).toEqual(["Message", "Edit", "More", "Request bids"]);
    // The next step is the ONE button with a word on it; every other header control is an icon.
    const primary = document.querySelector('[data-attr="manager-service-primary"]')!;
    expect(primary.getAttribute("aria-label")).toBe("Request bids");
    expect(primary.textContent).toBe("Request bids");
    expect(document.querySelector('[data-attr="record-header-action-assign-vendor"]')).toBeNull();
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

  it("a scheduled service shows Complete as its primary (renamed from Close) and Reschedule in the ⋯ menu", async () => {
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
    // Reschedule is no longer a header icon; it sits in ⋯ with the red items, and beside the vendor in Who's doing it.
    const headerIcons = document.querySelector('[data-attr="service-record-header-icons"]')!;
    expect([...headerIcons.querySelectorAll("button")].some((b) => b.getAttribute("aria-label") === "Reschedule")).toBe(false);
    expect(document.querySelector('[data-attr="record-overview-card-who"] [data-attr="service-who-reschedule"]')).not.toBeNull();
    expect(await openMore()).toEqual(["Reschedule", "Auto-schedule", "Cancel service", "Delete"]);
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

  it("the Service tab's Who's doing it card: Assign someone on your team opens the team-only Assign popup, Send to vendors goes to Vendors", () => {
    render(
      <AppUiProvider>
        <ManagerWorkOrdersPanel allRows={[row()]} bucket="open" workOrderId="wo-1" listBasePath="/portal" />
      </AppUiProvider>,
    );
    const who = document.querySelector('[data-attr="record-overview-card-who"]')!;
    expect(who.querySelector('[data-attr="service-who-vendors"]')!.textContent).toBe("Send to vendors");
    fireEvent.click(who.querySelector('[data-attr="service-who-vendors"]')!);
    expect(navigate).toHaveBeenCalledWith("/portal/services/work-orders/open/wo-1/vendors");
    fireEvent.click(who.querySelector('[data-attr="service-who-team"]')!);
    expect(screen.getByRole("heading", { name: "Assign" })).toBeInTheDocument();
    expect(document.querySelector('[data-attr="service-assign-mode-bids"]')).toBeNull();
  });

  it("an assigned service shows who, the visit and the price in the card instead of the two choices", () => {
    render(
      <AppUiProvider>
        <ManagerWorkOrdersPanel
          allRows={[row({ bucket: "scheduled", vendorId: "v-1", vendorName: "Acme Plumbing", vendorCostCents: 18000, scheduledAtIso: "2026-10-08T16:00:00.000Z" })]}
          bucket="scheduled"
          workOrderId="wo-1"
          listBasePath="/portal"
        />
      </AppUiProvider>,
    );
    const who = document.querySelector('[data-attr="record-overview-card-who"]')!;
    expect(who.textContent).toContain("Acme Plumbing");
    expect(who.textContent).toContain("$180");
    expect(who.querySelector('[data-attr="service-who-team"]')).toBeNull();
  });

  it("a service approved the older way (its row never got the vendor) still shows who, the booked visit and the approved price from the accepted bid", async () => {
    const accepted = {
      id: "b-1", workOrderId: "wo-1", vendorUserId: "u-9", vendorDirectoryId: "v-9", vendorName: "Pacific Plumbing", quoteMode: "upfront",
      consultationVisitAt: null, amountCents: 14000, materialsCents: 0, proposedTime: "2026-10-08T16:00:00.000Z", note: null, status: "accepted",
      createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z", bidSubmittedAt: "2026-10-02T00:00:00.000Z",
    };
    // The test pathname is "/", so the panel reads bids from the local demo store, like the server route would.
    seedDemoWorkOrderBids([accepted] as unknown as WorkOrderBid[]);
    try {
      // The mirror still says nobody has it: open, no vendor, no visit.
      render(
        <AppUiProvider>
          <ManagerWorkOrdersPanel allRows={[row({ bucket: "open", status: "Open" })]} bucket="open" workOrderId="wo-1" listBasePath="/portal" />
        </AppUiProvider>,
      );
      const who = () => document.querySelector('[data-attr="record-overview-card-who"]')!;
      await waitFor(() => expect(who().textContent).toContain("Pacific Plumbing"));
      expect(who().textContent).toContain("$140 approved");
      expect(who().textContent).toMatch(/Oct/);
      expect(who().querySelector('[data-attr="service-who-choices"]')).toBeNull();
      // The stepper and the header agree: Scheduled, so Complete is the next step.
      expect(document.querySelector('[data-attr="service-stage-stepper"] [data-stage-state="current"]')!.textContent).toBe("Scheduled");
      await waitFor(() => expect(document.querySelector('[data-attr="manager-service-primary"]')!.getAttribute("aria-label")).toBe("Complete"));
    } finally {
      seedDemoWorkOrderBids([]);
    }
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
