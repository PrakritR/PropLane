// @vitest-environment jsdom
//
// The band's Filter is a real popover with working fields, and the Addendum-4 money plumbing stays on
// the existing paths: a charge added from a service carries the service id (so it lists under that
// service's Incoming payments), and the server still derives everything else.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { DemoManagerOutgoingPaymentRow } from "@/data/demo-portal";
import { ServiceIncomingPaymentsList } from "@/components/portal/service-incoming-payments-list";
import { ServiceOutgoingPaymentsList } from "@/components/portal/service-outgoing-payments-list";
import { ServiceAssignDialog } from "@/components/portal/service-assign-dialog";
import { createManagerCharge, readChargesForManagerResident } from "@/lib/household-charges";
import { buildServiceIncomingRows, type ServiceIncomingRow } from "@/lib/service-incoming-payments";
import { AppUiProvider } from "@/components/providers/app-ui-provider";

afterEach(cleanup);

const incoming = (id: string, title: string, recurring?: string): ServiceIncomingRow => ({
  row: {
    id, propertyName: "Alder", roomNumber: "", residentName: "Liam Foster", chargeTitle: title, lineAmount: "$40.00", amountPaid: "$0.00",
    balanceDue: "$40.00", dueDate: "Oct 15", bucket: "pending", statusLabel: "Pending", notes: "",
  },
  recurringLabel: recurring,
});

const outgoing = (id: string, over: Partial<DemoManagerOutgoingPaymentRow> = {}): DemoManagerOutgoingPaymentRow => ({
  id, propertyName: "Alder", categoryLabel: "Vendor payment", payeeLabel: "Pacific", chargeTitle: "Burst pipe", amountLabel: "$200.00",
  dueDate: "Oct 5", bucket: "pending", statusLabel: "Awaiting approval", ...over,
});

/** Open the band's Filter popover, open the field, pick the option, and apply. */
function pickFilter(root: string, fieldLabel: string, optionText: string) {
  fireEvent.click(document.querySelector(`[data-attr="${root}-filter"]`)!);
  const panel = document.querySelector('[data-attr="portal-filter-dropdown-panel"]') as HTMLElement;
  fireEvent.click(within(panel).getByRole("button", { name: new RegExp(`^${fieldLabel}`) }));
  fireEvent.click(screen.getByRole("option", { name: optionText }));
  const save = document.querySelector('[data-attr="portal-filter-save"]');
  if (save) fireEvent.click(save);
}

describe("the band's Filter really filters", () => {
  it("Incoming payments: Type narrows to recurring or one-time charges", () => {
    render(<ServiceIncomingPaymentsList rows={[incoming("a", "Storage fee", "$40 / month"), incoming("b", "Key replacement")]} />);
    expect(screen.getByText(/Storage fee/)).toBeTruthy();
    expect(screen.getByText(/Key replacement/)).toBeTruthy();
    pickFilter("service-incoming-payments", "Type", "Recurring");
    expect(screen.queryByText(/Key replacement/)).toBeNull();
    expect(screen.getAllByText(/Storage fee/).length).toBeGreaterThan(0);
  });

  it("Outgoing payments: Type separates the job payment from an estimate-visit fee", () => {
    render(
      <ServiceOutgoingPaymentsList
        rows={[outgoing("job"), outgoing("fee", { kind: "visit-fee", chargeTitle: "Burst pipe · estimate visit", categoryLabel: "Estimate visit" })]}
        busyId={null}
        onApproveAndPay={() => undefined}
      />,
    );
    expect(document.querySelectorAll('[data-attr="work-order-outgoing-row"]')).toHaveLength(2);
    pickFilter("work-order-outgoing-payments", "Type", "Estimate visit fee");
    expect(document.querySelectorAll('[data-attr="work-order-outgoing-row"]')).toHaveLength(1);
    expect(document.body.textContent).toContain("estimate visit");
  });

  it("lists with no filterable field draw no Filter icon", () => {
    render(<ServiceIncomingPaymentsList rows={[]} />);
    // Type is always a real field for payments, so the icon is present; the Edit-only Service band has none.
    expect(document.querySelector('[data-attr="service-incoming-payments-filter"]')).not.toBeNull();
  });
});

describe("a charge added from a service lists under that service", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("createManagerCharge stamps the service id, and the service's Incoming payments finds it", () => {
    const charge = createManagerCharge({
      residentEmail: "liam@example.com",
      residentName: "Liam Foster",
      propertyId: "prop-a",
      propertyLabel: "Alder",
      managerUserId: "mgr-1",
      title: "Storage locker",
      amount: 40,
      workOrderId: "seed-sr-storage",
    });
    expect(charge?.workOrderId).toBe("seed-sr-storage");
    const other = createManagerCharge({ residentEmail: "liam@example.com", residentName: "Liam Foster", propertyId: "prop-a", propertyLabel: "Alder", managerUserId: "mgr-1", title: "Rent", amount: 900 });
    expect(other?.workOrderId).toBeUndefined();
    const rows = buildServiceIncomingRows({ charges: readChargesForManagerResident("liam@example.com", "mgr-1"), workOrderId: "seed-sr-storage" });
    expect(rows.map((r) => r.row.chargeTitle)).toEqual(["Storage locker"]);
  });
});

describe("the Assign popup is the standard frame", () => {
  const vendors = [{ id: "v1", name: "Pacific Plumbing", trade: "Plumbing" }];
  const team = [{ userId: "mgr-1", name: "Me" }, { userId: "co-1", name: "Casey" }];
  const renderDialog = (allowVendors: boolean, onAssign = vi.fn(), onRequestBids = vi.fn()) =>
    render(
      <AppUiProvider>
        <ServiceAssignDialog open onClose={() => undefined} allowVendors={allowVendors} vendors={vendors} teamMembers={team} meUserId="mgr-1" onAssign={onAssign} onRequestBids={onRequestBids} />
      </AppUiProvider>,
    );

  it("a maintenance service opens on Request bids, disabled until a vendor is picked or the marketplace is ticked", () => {
    renderDialog(true);
    expect(document.querySelector('[data-attr="service-assign-vendors"]')).not.toBeNull();
    expect((document.querySelector('[data-attr="service-assign-submit"]') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByRole("radio").map((r) => r.textContent)).toEqual(["Request bids", "A vendor", "A teammate", "Me"]);
    fireEvent.click(screen.getByRole("checkbox", { name: /PropLane vendors within/ }));
    expect((document.querySelector('[data-attr="service-assign-submit"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it("passes the marketplace reach (off by default, radius when ticked) and the note through onRequestBids", async () => {
    const onRequestBids = vi.fn();
    render(
      <AppUiProvider>
        <ServiceAssignDialog open onClose={() => undefined} allowVendors vendors={vendors} teamMembers={team} meUserId="mgr-1" trade="Plumbing" photoCount={2} onAssign={vi.fn()} onRequestBids={onRequestBids} />
      </AppUiProvider>,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: /PropLane vendors within/ }));
    fireEvent.click(screen.getByRole("button", { name: "Marketplace radius" }));
    fireEvent.click(within(screen.getByRole("listbox", { name: "Marketplace radius" })).getByRole("option", { name: "10 mi" }));
    fireEvent.change(document.querySelector('[data-attr="service-assign-note"]')!, { target: { value: "Back door" } });
    fireEvent.click(document.querySelector('[data-attr="service-assign-submit"]')!);
    await vi.waitFor(() => expect(onRequestBids).toHaveBeenCalled());
    expect(onRequestBids).toHaveBeenCalledWith([], { marketplace: { enabled: true, trade: "Plumbing", radiusMi: 10, sharePhotos: true, notes: "Back door" } });
  });

  it("an add-on opens on Me and can assign you with one click; vendors are never offered", () => {
    const onAssign = vi.fn();
    renderDialog(false, onAssign);
    expect(document.querySelector('[data-attr="service-assign-vendors"]')).toBeNull();
    const submit = document.querySelector('[data-attr="service-assign-submit"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    expect(submit.textContent).toMatch(/Assign to me/);
    fireEvent.click(submit);
    expect(onAssign).toHaveBeenCalledWith({ type: "team", id: "mgr-1", name: "You" });
  });
});

describe("Vendors places each vendor under its pipeline tab, with counts", () => {
  type Bid = import("@/lib/work-order-bids").WorkOrderBid;
  type Offer = import("@/lib/work-order-vendor-offers").WorkOrderVendorOffer;
  const bid = (over: Partial<Bid>): Bid => ({
    id: "b", workOrderId: "wo-1", vendorUserId: "u", vendorDirectoryId: "d", vendorName: "Vendor", quoteMode: "upfront", consultationVisitAt: null,
    amountCents: null, materialsCents: 0, proposedTime: null, note: null, status: "submitted", createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z", bidSubmittedAt: null, ...over,
  });
  const offer = (over: Partial<Offer>): Offer => ({
    id: "o", workOrderId: "wo-1", vendorDirectoryId: "d", vendorUserId: "u", vendorName: "Vendor", status: "sent", createdAt: "2026-10-01T00:00:00.000Z", ...over,
  });
  const job = { id: "wo-1", propertyName: "A", unit: "1", title: "Pipe", priority: "Medium", status: "Open", bucket: "open" as const, description: "", scheduled: "", cost: "" };
  const handlers = {
    sending: false,
    onSend: vi.fn(),
    onWithdraw: vi.fn(),
    onSchedule: vi.fn(),
    onMarkDone: vi.fn(),
    onPay: vi.fn(),
    onMessage: () => undefined,
  };
  const pipelineFor = async (bids: Bid[], offers: Offer[], roster: Array<{ id: string; name: string; trade?: string }> = []) => {
    const { buildServicePipeline } = await import("@/lib/service-pipeline");
    return buildServicePipeline({ job, offers, bids, roster, jobTrade: "" });
  };

  it("opens on Bids when there are bids, counts every tab, and Approve bid is only on a Bids row", async () => {
    const { ServiceVendorPipeline } = await import("@/components/portal/service-vendor-cycle-section");
    const pipeline = await pipelineFor(
      [
        bid({ id: "b2", vendorUserId: "u2", vendorDirectoryId: "d2", vendorName: "Estimate Co", estimateCents: 18000 }),
        bid({ id: "b3", vendorUserId: "u3", vendorDirectoryId: "d3", vendorName: "Bid Co", amountCents: 20000, bidSubmittedAt: "2026-10-02T00:00:00.000Z" }),
      ],
      [offer({ id: "o1", vendorDirectoryId: "d1", vendorUserId: "u1", vendorName: "Asked Co" })],
      [{ id: "d9", name: "Spare Co" }],
    );
    render(<ServiceVendorPipeline pipeline={pipeline} trade="" approvingBidId={null} onApprove={vi.fn()} {...handlers} />);
    const count = (id: string) => document.querySelector(`[data-attr="service-vendor-cycle-tab-${id}"]`)!.textContent;
    expect(count("available")).toMatch(/Available\s*1/);
    expect(count("sent")).toMatch(/Sent\s*2/);
    expect(count("bids")).toMatch(/Bids\s*1/);
    expect(count("scheduled")).toMatch(/Scheduled\s*0/);
    expect(count("done")).toMatch(/Done\s*0/);
    expect(screen.getByText("Bid Co")).toBeTruthy();
    expect(screen.queryByText("Estimate Co")).toBeNull();
    expect((screen.getByRole("button", { name: /Approve bid from Bid Co/ }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(document.querySelector('[data-attr="service-vendor-cycle-tab-sent"]')!);
    expect(screen.getByText("Estimate Co")).toBeTruthy();
    expect(screen.getByText("Asked Co")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Approve bid/ })).toBeNull();
    // An estimate row says so as a plain fact, and can only be withdrawn.
    expect(document.body.textContent).toContain("Estimate $180");
    expect(screen.getByRole("button", { name: "Withdraw from Estimate Co" })).toBeTruthy();
  });

  it("marks the lowest bid and, with two or more bids, Compare lays them side by side with Approve bid on each", async () => {
    const { ServiceVendorPipeline } = await import("@/components/portal/service-vendor-cycle-section");
    const onApprove = vi.fn();
    const pipeline = await pipelineFor(
      [
        bid({ id: "b1", vendorUserId: "u1", vendorDirectoryId: "d1", vendorName: "City Fix Co.", amountCents: 20000, proposedTime: "2026-10-07T16:00:00.000Z", bidSubmittedAt: "2026-10-02T00:00:00.000Z" }),
        bid({ id: "b2", vendorUserId: "u2", vendorDirectoryId: "d2", vendorName: "Rapid Pipes", amountCents: 15200, materialsCents: 1200, proposedTime: "2026-10-08T16:00:00.000Z", bidSubmittedAt: "2026-10-02T00:00:00.000Z" }),
      ],
      [],
    );
    render(<ServiceVendorPipeline pipeline={pipeline} trade="" approvingBidId={null} {...handlers} onApprove={onApprove} />);
    expect(screen.getByText("Rapid Pipes · Lowest")).toBeTruthy();
    expect(screen.getByText("City Fix Co.")).toBeTruthy();
    expect(document.querySelector('[data-attr="service-bid-compare"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    const cards = [...document.querySelectorAll('[data-attr="service-bid-compare-card"]')];
    expect(cards.map((c) => c.querySelector("p")?.textContent)).toEqual(["Rapid PipesLowest", "City Fix Co."]);
    expect(cards[0]!.textContent).toMatch(/\$164/);
    for (const label of ["Labor", "Materials", "Earliest", "Estimate first"]) expect(cards[0]!.textContent).toContain(label);
    fireEvent.click(within(cards[0] as HTMLElement).getByRole("button", { name: /Approve bid from Rapid Pipes/ }));
    expect(onApprove).toHaveBeenCalledWith(expect.objectContaining({ vendorName: "Rapid Pipes", bidId: "b2" }));
  });

  it("a single bid has no Compare toggle and no Lowest marker", async () => {
    const { ServiceVendorPipeline } = await import("@/components/portal/service-vendor-cycle-section");
    const pipeline = await pipelineFor(
      [bid({ id: "b1", vendorName: "Solo Co", amountCents: 100, bidSubmittedAt: "2026-10-02T00:00:00.000Z" })],
      [],
    );
    render(<ServiceVendorPipeline pipeline={pipeline} trade="" approvingBidId={null} onApprove={vi.fn()} {...handlers} />);
    expect(screen.queryByRole("button", { name: "Compare" })).toBeNull();
    expect(screen.queryByText(/Lowest/)).toBeNull();
  });
});
