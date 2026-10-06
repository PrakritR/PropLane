// @vitest-environment jsdom
//
// Every list tab on the SERVICE record and the VENDOR record opens with the standard list header band
// (tabs with counts, search, the round + where a create exists) and puts rows, or the one standard
// empty card, UNDER it - never a bare centered card at the top of the tab.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
vi.mock("@/components/portal/pro-add-payment-modal", () => ({
  ManagerAddPaymentModal: (p: { initialResidentEmail?: string; initialPropertyId?: string; initialTitle?: string; serviceRecordId?: string }) => (
    <div data-attr="mock-add-charge" data-resident={p.initialResidentEmail} data-property={p.initialPropertyId} data-title={p.initialTitle} data-service={p.serviceRecordId} />
  ),
}));
vi.mock("@/components/portal/pro-add-outgoing-payment-modal", () => ({
  ManagerAddOutgoingPaymentModal: (p: { initialPropertyId?: string; initialVendorId?: string; initialMemo?: string }) => (
    <div data-attr="mock-add-payment" data-property={p.initialPropertyId} data-vendor={p.initialVendorId} data-memo={p.initialMemo} />
  ),
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
  expect(band.firstElementChild!.querySelector("input")).not.toBeNull();
};

describe("every service record section opens with the standard band", () => {
  it("Service: ONE page - stepper, Who's doing it, Request + Home, Photos (count, add icon), Activity - with no sub-tabs and no stat tiles", () => {
    renderTab("service", wo({ photoDataUrls: ["https://example.com/a.jpg"], vendorAssignedAt: "2026-10-02T00:00:00.000Z", priority: "High" }));
    const page = document.querySelector('[data-attr="service-details"]')!;
    // No Details / Photos / Activity tabs and no band at all on this page.
    expect(page.querySelector('[data-attr^="service-details-tab-"]')).toBeNull();
    expect(screen.queryByRole("button", { name: /^Details/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Photos/ })).toBeNull();
    // The four stat tiles are gone: status is the stepper, priority is in Request, assignee and cost in Who's doing it.
    for (const id of ["status", "priority", "vendor", "cost"]) expect(document.querySelector(`[data-attr="record-overview-tile-${id}"]`)).toBeNull();
    // Top to bottom.
    const order = ["service-stage-stepper", "record-overview-card-who", "record-overview-card-request", "record-overview-card-home", "service-photos", "service-activity"].map((id) => {
      const el = page.querySelector(`[data-attr="${id}"]`);
      expect(el, id).not.toBeNull();
      return el!;
    });
    for (let i = 1; i < order.length; i += 1) expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING, `${i}`).toBeTruthy();
    const stepper = page.querySelector('[data-attr="service-stage-stepper"]')!;
    expect([...stepper.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["Open", "Assigned", "Scheduled", "Completed"]);
    // Request carries the priority; nobody yet: the two choices.
    expect(page.querySelector('[data-attr="record-overview-card-request"]')!.textContent).toMatch(/Priority\s*High/);
    expect(page.querySelector('[data-attr="record-overview-card-who"]')!.textContent).toMatch(/Who's doing it/);
    expect(document.querySelector('[data-attr="record-overview-card-assignment"]')).toBeNull();
    // Photos: a count and the add-photo icon in the card header; Activity is a timeline.
    expect(page.querySelector('[data-attr="service-photos"] h2')!.textContent).toMatch(/Photos\s*1/);
    expect(page.querySelector('[data-attr="service-photos"] [data-attr="service-photos-add"]')).not.toBeNull();
    expect(page.querySelector('[data-attr="work-order-photos"]')).not.toBeNull();
    expect(page.querySelector('[data-attr="service-activity"] [data-attr="record-activity-list"]')).not.toBeNull();
    // The Needs-you row is gone with the tiles; its one action is the header's labeled primary.
    expect(document.querySelector('[data-attr="record-overview-needs-you"]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/Progress/);
  });

  it("Service with no photos says None yet", () => {
    renderTab("service");
    expect(document.querySelector('[data-attr="service-photos"]')!.textContent).toMatch(/Photos\s*0/);
    expect(document.querySelector('[data-attr="work-order-photos-empty"]')!.textContent).toBe("None yet");
  });

  it("Vendors: Available · Sent · Bids · Scheduled · Done with counts and search; the round + opens Send job, no bar, no stage line", () => {
    renderTab("vendors");
    expect(bandTabs("service-vendor-cycle")).toEqual(["Available", "Sent", "Bids", "Scheduled", "Done"]);
    const band = document.querySelector('[data-attr="service-vendor-cycle"]')!;
    expect(band.firstElementChild!.contains(screen.getByPlaceholderText("Search vendors"))).toBe(true);
    // The send-out lives behind the band's round + (a popup), never a sticky bar of its own.
    expect(band.querySelector('[data-attr="service-send-plus"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="service-send-bar"]')).toBeNull();
    // One band: no separate stage / progress lines, no old Assign dropdown card.
    expect(band.querySelector('[data-attr="service-progress-line"]')).toBeNull();
    expect(band.querySelector('[data-attr="service-stage-stepper"]')).toBeNull();
    expect(band.querySelector('[data-attr="service-assign-select"]')).toBeNull();
    expect(document.querySelectorAll('[data-attr="portal-list-empty-card"]')).toHaveLength(1);
  });

  it("Incoming payments: Pending · Overdue · Paid, search, Filter, the round + (Add charge)", () => {
    renderTab("incoming-payments");
    expect(bandTabs("service-incoming-payments")).toEqual(["Pending", "Overdue", "Paid"]);
    expect(screen.getByPlaceholderText("Search charges")).toBeTruthy();
    expect(document.querySelector('[data-attr="service-incoming-payments-filter"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: "Add charge" })).toBeTruthy();
    expect(document.querySelector('[data-attr="portal-list-empty-card"]')).not.toBeNull();
  });

  it("Outgoing payments: To pay · Paid, search, Filter, the round + (Add payment)", () => {
    renderTab("outgoing-payments");
    expect(bandTabs("work-order-outgoing-payments")).toEqual(["To pay", "Paid"]);
    expect(screen.getByPlaceholderText("Search payments")).toBeTruthy();
    expect(document.querySelector('[data-attr="work-order-outgoing-payments-filter"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: "Add payment" })).toBeTruthy();
    expect(document.querySelector('[data-attr="portal-list-empty-card"]')).not.toBeNull();
  });

  it("Communication: the band sits ABOVE the thread, with the counterparty as its tab", () => {
    renderTab("communication", wo({ residentName: "Maya Chen", residentEmail: "maya@example.com" }));
    expect(bandTabs("service-communication")).toEqual(["Maya Chen"]);
    const pane = document.querySelector('[data-attr="service-communication-pane"]')!;
    const band = pane.querySelector('[data-attr="service-communication"]') ?? pane.firstElementChild!;
    const thread = pane.querySelector('[data-attr="mock-thread"]')!;
    expect(band.compareDocumentPosition(thread) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("an Overdue charge turns the Overdue tab red (alert) only while its count is above zero", () => {
    const src = read("src/components/portal/service-incoming-payments-list.tsx");
    expect(src).toContain('alert: t.id === "overdue" && counts.overdue > 0');
  });
});

describe("Assign opens one team-only popup, from the Who's doing it card", () => {
  it("the card's first choice opens it: A teammate / Me only, nothing chosen yet - no Request bids, no vendors", () => {
    renderTab("service");
    expect(document.querySelector('[data-attr="service-assign-dialog"]')).toBeNull();
    fireEvent.click(document.querySelector('[data-attr="service-who-team"]') as HTMLElement);
    const dialog = document.querySelector('[data-attr="service-assign-dialog"]') as HTMLElement;
    expect(dialog).not.toBeNull();
    expect(within(dialog).getAllByRole("radio").map((r) => r.textContent)).toEqual(["Me"]);
    expect(within(dialog).queryByRole("checkbox", { name: /PropLane vendors within/ })).toBeNull();
    expect(screen.getByRole("heading", { name: "Assign" })).toBeTruthy();
  });

  it("Send to vendors goes to Vendors, where the job is sent out from Available", () => {
    renderTab("service");
    fireEvent.click(document.querySelector('[data-attr="service-who-vendors"]') as HTMLElement);
    expect(document.querySelector('[data-attr="service-assign-dialog"]')).toBeNull();
  });

  it("Me assigns with one click", () => {
    renderTab("service");
    fireEvent.click(document.querySelector('[data-attr="service-who-team"]') as HTMLElement);
    expect((document.querySelector('[data-attr="service-assign-submit"]') as HTMLButtonElement).textContent).toBe("Assign to me");
  });
});

describe("+ on Incoming and Outgoing opens the existing flows, prefilled with this service", () => {
  it("Incoming + opens Add charge for the resident, the property and the service", () => {
    renderTab("incoming-payments", wo({ residentEmail: "maya@example.com", residentName: "Maya Chen", propertyId: "prop-a" }));
    fireEvent.click(screen.getByRole("button", { name: "Add charge" }));
    const modal = document.querySelector('[data-attr="mock-add-charge"]')!;
    expect(modal).not.toBeNull();
    expect(modal.getAttribute("data-resident")).toBe("maya@example.com");
    expect(modal.getAttribute("data-property")).toBe("prop-a");
    expect(modal.getAttribute("data-title")).toBe("Fix sink");
    expect(modal.getAttribute("data-service")).toBe("wo-1");
  });

  it("Outgoing + opens the add-payment flow for the property, the vendor and the service name", () => {
    renderTab("outgoing-payments", wo({ vendorId: "vendor-1", vendorName: "Pacific", propertyId: "prop-a" }));
    fireEvent.click(screen.getByRole("button", { name: "Add payment" }));
    const modal = document.querySelector('[data-attr="mock-add-payment"]')!;
    expect(modal).not.toBeNull();
    expect(modal.getAttribute("data-property")).toBe("prop-a");
    expect(modal.getAttribute("data-vendor")).toBe("vendor-1");
    expect(modal.getAttribute("data-memo")).toBe("Fix sink");
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
    // The Service page is one page (no band); only Communication opens with the tab band.
    expect(read("src/components/portal/service-communication-pane.tsx")).toContain("<RecordTabBand");
    expect(read("src/components/portal/service-details-section.tsx")).not.toContain("RecordTabBand");
  });

  it("the vendor record's Outgoing payments (To pay · Scheduled · Paid) and Reviews tabs use the same control stack", () => {
    expect(read("src/components/portal/manager-outgoing-invoices-panel.tsx")).toMatch(/<PortalListControlStack [^>]*variant="command"/);
    expect(read("src/components/portal/pro-vendor-detail.tsx")).toContain("PortalListControlStack");
  });

  it("no tab opens on a bare centered card", () => {
    const outgoing = read("src/components/portal/pro-work-orders-panel.tsx");
    expect(outgoing).not.toContain("Nothing to pay on this service");
    expect(read("src/components/portal/service-incoming-payments-list.tsx")).not.toContain("No charges for this service");
  });
});

describe("list-band tabs", () => {
  it("draw their focus ring inside the tab, so the scrolling row cannot clip it into a stray bar on the active tab's edge", () => {
    const css = read("src/app/globals.css");
    const rule = css.match(/\.portal-shell :is\(([^)]*\[data-slot="local-destination-nav"\] button[^)]*)\):focus-visible \{([^}]*)\}/);
    expect(rule, "the inset focus rule must name the command tabs").not.toBeNull();
    expect(rule![1]).toContain('[data-slot="destination-nav"] a');
    expect(rule![2]).toContain("outline-offset: -2px");
  });
});

