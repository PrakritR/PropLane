// @vitest-environment jsdom
// The manager's vendor record follows the property tabs: every tab body is a header card (text tab + count,
// search, round + only where adding makes sense), flat shared rows, or the one standard empty card. Outgoing
// payments lists payments to this vendor RECORD (linked login or not), and the header icons say what they do.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { ManagerVendorDetail } from "@/components/portal/pro-vendor-detail";
import { PortalRecordHeaderIconActions } from "@/components/portal/portal-record-section-chrome";
import { recordSections } from "@/lib/portals/record-sections";
import type { ManagerVendorRow } from "@/lib/manager-vendors-storage";
import { seedDemoWorkOrderBids } from "@/lib/work-order-bids-storage";
import type { WorkOrderBid } from "@/lib/work-order-bids";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/vendors/v-1",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("@/hooks/use-manager-messaging-number-status", () => ({
  useManagerMessagingNumberStatus: () => ({ status: null }),
}));
vi.mock("@/components/portal/record-communication-section", () => ({
  RecordCommunicationSection: (props: { recordRef: { kind: string; id: string }; contactIds?: string[]; fill?: boolean }) => (
    <div data-attr="mock-record-communication" data-fill={String(Boolean(props.fill))} data-kind={props.recordRef.kind} data-id={props.recordRef.id} data-contact={(props.contactIds ?? []).join(",")} />
  ),
}));

const serviceFixtures = vi.hoisted(() => ({
  workOrders: [] as Array<Record<string, unknown>>,
  bids: [] as Array<Record<string, unknown>>,
  offers: [] as Array<Record<string, unknown>>,
}));
vi.mock("@/lib/manager-work-orders-storage", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readManagerWorkOrderRows: () => serviceFixtures.workOrders,
  syncManagerWorkOrdersFromServer: async () => serviceFixtures.workOrders,
}));

const summaryState = vi.hoisted(() => ({
  value: {
    jobs: [] as Array<Record<string, unknown>>,
    totalJobCount: 0, ratingCount: 0, ratingAverage: null, completedJobCount: 0,
    completedInvoiceTotalCents: null, completedInvoiceAverageCents: null,
  },
}));
vi.mock("@/lib/manager-vendor-summary-client", () => ({
  loadManagerVendorSummary: async () => summaryState.value,
  invalidateManagerVendorSummary: () => {},
}));

const vendor = (overrides: Partial<ManagerVendorRow> = {}): ManagerVendorRow => ({
  id: "v-1", managerUserId: "mgr-1", name: "Pacific Plumbing", trade: "Plumbing", phone: "555-0100", email: "hello@pacific.test", notes: "", active: true, ...overrides,
});

const bill = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, status, vendorId: "v-1", vendorUserId: "login-1", vendorName: "Pacific Plumbing", workOrderId: "wo-1", serviceTitle: "Burst pipe", propertyName: "Alder House",
  invoiceNumber: id, lineItems: [], subtotalCents: 12500, taxCents: 0, totalCents: 12500, currency: "usd", memo: null, decisionNote: null, billId: null,
  submittedAt: "2026-09-10T12:00:00.000Z", decidedAt: "2026-09-10T12:00:00.000Z", paidAt: null, paidFrom: null, ...extra,
});

const fetched: string[] = [];
let outgoing: { invoices: unknown[]; payouts: unknown[] } = { invoices: [], payouts: [] };
let reviews: unknown[] = [];

beforeEach(() => {
  fetched.length = 0;
  outgoing = { invoices: [], payouts: [] };
  reviews = [];
  serviceFixtures.workOrders = [];
  serviceFixtures.bids = [];
  serviceFixtures.offers = [];
  seedDemoWorkOrderBids([]);
  summaryState.value = { jobs: [], totalJobCount: 0, ratingCount: 0, ratingAverage: null, completedJobCount: 0, completedInvoiceTotalCents: null, completedInvoiceAverageCents: null };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    fetched.push(String(url));
    const u = String(url);
    const body = u.startsWith("/api/manager/vendor-invoices?status")
      ? { ...outgoing, totals: { owedCents: 0, paidThisYearCents: 0 } }
      : u.startsWith("/api/portal/vendor-reviews")
        ? { reviews, aggregate: { average: null, count: reviews.length } }
        : u.startsWith("/api/portal/work-order-bids")
          ? { bids: serviceFixtures.bids }
          : u.startsWith("/api/portal/work-order-vendor-offers")
            ? { offers: serviceFixtures.offers }
            : {};
    return { ok: true, status: 200, json: async () => body } as Response;
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const renderDetail = (tab: React.ComponentProps<typeof ManagerVendorDetail>["tab"], row = vendor()) =>
  render(<AppUiProvider><ManagerVendorDetail row={row} managerUserId="mgr-1" onNavigate={vi.fn()} tab={tab} /></AppUiProvider>);

const tabCount = (label: string) => {
  const tab = screen.getAllByRole("button", { name: new RegExp(`^${label}`) }).find((el) => /\d/.test(el.textContent ?? ""));
  return tab?.textContent ?? "";
};

describe("Reviews tab", () => {
  it("is one header card with Manager ratings <n>, Resident ratings <n>, a disabled round + and one standard empty card, with no subtext sentences", async () => {
    renderDetail("reviews");
    await waitFor(() => expect(document.querySelector('[data-attr="portal-list-empty-card"]')).not.toBeNull());
    expect(tabCount("Manager ratings")).toMatch(/Manager ratings\s*0/);
    expect(tabCount("Resident ratings")).toMatch(/Resident ratings\s*0/);
    const add = screen.getByRole("button", { name: /^Add review/ }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(add.getAttribute("aria-label")).toBe("Add review — needs a completed service or an estimate");
    expect(screen.getByText("No reviews of Pacific Plumbing yet")).toBeTruthy();
    expect(screen.queryByText(/No reviews from PropLane managers yet/)).toBeNull();
    expect(screen.queryByText(/No completed-service ratings/)).toBeNull();
  });

  it("lists a manager review as a flat row with initials, rating, text and date, and resident ratings as rows in their own tab", async () => {
    reviews = [{ id: "r1", stars: 4, body: "Fast and tidy", reviewerLabel: "A PropLane manager", isOwnWorkspace: false, workOrderId: "wo-1", vendorReply: null, createdAt: "2026-09-12T12:00:00.000Z" }];
    summaryState.value = { ...summaryState.value, jobs: [{ id: "wo-1", title: "Burst pipe", propertyName: "Alder House", unit: null, status: "completed", acceptedQuoteCents: null, finalInvoiceCents: 12500, paidCents: null, residentRating: 5 }] };
    renderDetail("reviews", vendor({ vendorUserId: "login-1" }));
    await waitFor(() => expect(document.querySelectorAll('[data-attr="vendor-review-row"]').length).toBe(1));
    expect(screen.getByText("Fast and tidy")).toBeTruthy();
    expect(screen.getByText("Sep 12, 2026")).toBeTruthy();
    expect(tabCount("Manager ratings")).toMatch(/Manager ratings\s*1/);
    fireEvent.click(screen.getAllByRole("button", { name: /^Resident ratings/ })[0]!);
    await waitFor(() => expect(document.querySelectorAll('[data-attr="vendor-resident-rating-row"]').length).toBe(1));
    expect(screen.getByText("Resident rating")).toBeTruthy();
    expect(screen.getAllByText("5 / 5").length).toBeGreaterThan(0);
  });

  it("enables Add review for a service the vendor has estimated, and keeps it off without a portal login or a review-able service", async () => {
    summaryState.value = { ...summaryState.value, jobs: [{ id: "wo-2", title: "Water heater", propertyName: "Alder House", unit: null, status: "scheduled", acceptedQuoteCents: null, finalInvoiceCents: null, paidCents: null, residentRating: null, estimateGiven: true }] };
    renderDetail("reviews", vendor({ vendorUserId: "login-1" }));
    await waitFor(() => expect(document.querySelector('[data-attr="portal-list-empty-card"]')).not.toBeNull());
    await waitFor(() => expect((screen.getByRole("button", { name: "Add review" }) as HTMLButtonElement).disabled).toBe(false));
    cleanup();
    renderDetail("reviews", vendor());
    await waitFor(() => expect(document.querySelector('[data-attr="portal-list-empty-card"]')).not.toBeNull());
    expect((screen.getByRole("button", { name: /^Add review/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps Add review off for a service with no estimate that is not completed", async () => {
    summaryState.value = { ...summaryState.value, jobs: [{ id: "wo-3", title: "Gutter", propertyName: "Alder House", unit: null, status: "scheduled", acceptedQuoteCents: null, finalInvoiceCents: null, paidCents: null, residentRating: null, estimateGiven: false }] };
    renderDetail("reviews", vendor({ vendorUserId: "login-1" }));
    await waitFor(() => expect(document.querySelector('[data-attr="portal-list-empty-card"]')).not.toBeNull());
    expect((screen.getByRole("button", { name: /^Add review/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("source carries no explanatory sentence under the heading", () => {
    const source = read("src/components/portal/pro-vendor-detail.tsx");
    expect(source).not.toContain("No reviews from PropLane managers yet.");
    expect(source).not.toContain("No completed-service ratings from your portfolio yet.");
  });
});

describe("Services tab", () => {
  const wo = (over: Record<string, unknown>) => ({
    id: "wo-x", propertyName: "Alder House", unit: "2B", title: "Burst pipe", priority: "Medium", status: "Open", bucket: "open",
    description: "", scheduled: "—", cost: "—", ...over,
  });
  const bidRow = (over: Record<string, unknown>) => ({
    id: "bid-x", workOrderId: "wo-x", vendorUserId: "login-1", vendorDirectoryId: "v-1", quoteMode: "upfront", consultationVisitAt: null,
    amountCents: null, materialsCents: 0, proposedTime: null, note: null, status: "submitted",
    createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", ...over,
  });

  it("shows Open / Assigned / Scheduled / Completed with counts and the standard empty card when empty", async () => {
    renderDetail("services");
    await waitFor(() => expect(document.querySelector('[data-attr="portal-list-empty-card"]')).not.toBeNull());
    for (const label of ["Open", "Assigned", "Scheduled", "Completed"]) expect(tabCount(label)).toMatch(new RegExp(`${label}\\s*0`));
    expect(screen.getByText("No open services with Pacific Plumbing")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Add bid request" }).length).toBeGreaterThan(0);
  });

  it("opens the service when the row is clicked anywhere (title, facts, figure), through the real shared row", async () => {
    serviceFixtures.workOrders = [wo({ id: "wo-asg", title: "Filter swap", vendorId: "v-1", vendorName: "Pacific Plumbing", vendorCostCents: 14000 })];
    const onNavigate = vi.fn();
    render(<AppUiProvider><ManagerVendorDetail row={vendor()} managerUserId="mgr-1" basePath="/portal" onNavigate={onNavigate} tab="services" /></AppUiProvider>);
    fireEvent.click(screen.getAllByRole("button", { name: /^Assigned/ })[0]!);
    await waitFor(() => expect(screen.getByText("Filter swap")).toBeTruthy());
    const body = document.querySelector('[data-attr="vendor-service-row"]') as HTMLElement;
    const card = body.closest(".portal-property-row") as HTMLElement;
    fireEvent.click(screen.getByText("Filter swap"));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenLastCalledWith("/portal/services/work-orders/open/wo-asg");
    // Dead zones before the fix: the tile, the desktop figure beside the text, and the card's own padding.
    fireEvent.click(card.querySelector('[data-slot="portal-row-glyph-tile"]')!);
    expect(onNavigate).toHaveBeenCalledTimes(2);
    fireEvent.click(card.querySelector("div.md\\:flex span")!);
    expect(onNavigate).toHaveBeenCalledTimes(3);
    fireEvent.click(card);
    expect(onNavigate).toHaveBeenCalledTimes(4);
    fireEvent.click(body.querySelector('[data-attr="record-row-facts"]')!);
    expect(onNavigate).toHaveBeenCalledTimes(5);
  });

  it("buckets this vendor's services by the bid cycle and draws each through the shared Services row with their own figure", async () => {
    serviceFixtures.workOrders = [
      wo({ id: "wo-req", title: "Burst pipe" }),
      wo({ id: "wo-est", title: "Slow drain" }),
      wo({ id: "wo-bid", title: "Water heater" }),
      wo({ id: "wo-asg", title: "Filter swap", vendorId: "v-1", vendorName: "Pacific Plumbing", vendorCostCents: 14000 }),
      wo({ id: "wo-act", title: "Re-pipe", bucket: "scheduled", status: "Scheduled", vendorId: "v-1", vendorName: "Pacific Plumbing", scheduledAtIso: "2026-10-08T16:00:00.000Z", vendorCostCents: 30000 }),
      wo({ id: "wo-done", title: "Faucet", bucket: "completed", status: "Completed", vendorId: "v-1", vendorName: "Pacific Plumbing", automationStatus: "paid", vendorCostCents: 12500 }),
      wo({ id: "wo-lost", title: "Lost to another vendor", vendorId: "v-9", vendorName: "Other" }),
    ];
    serviceFixtures.offers = [{ id: "o1", workOrderId: "wo-req", vendorDirectoryId: "v-1", vendorUserId: null, status: "sent", createdAt: "2026-10-01T18:00:00.000Z" }];
    // Bids are read from the local demo store when the test pathname is "/", the same as the offers route.
    seedDemoWorkOrderBids([
      bidRow({ id: "b-est", workOrderId: "wo-est", estimateCents: 18000 }),
      bidRow({ id: "b-bid", workOrderId: "wo-bid", amountCents: 20000, materialsCents: 2500, bidSubmittedAt: "2026-10-02T00:00:00.000Z", proposedTime: "2026-10-08T16:00:00.000Z" }),
      bidRow({ id: "b-lost", workOrderId: "wo-lost", amountCents: 9000, bidSubmittedAt: "2026-10-02T00:00:00.000Z" }),
    ] as unknown as WorkOrderBid[]);
    renderDetail("services", vendor({ vendorUserId: "login-1" }));
    await waitFor(() => expect(document.querySelectorAll('[data-attr="vendor-service-row"]').length).toBe(3));
    expect(tabCount("Open")).toMatch(/Open\s*3/);
    expect(tabCount("Assigned")).toMatch(/Assigned\s*1/);
    expect(tabCount("Scheduled")).toMatch(/Scheduled\s*1/);
    expect(tabCount("Completed")).toMatch(/Completed\s*1/);
    // On Open the fact is this vendor's own answer.
    expect(document.body.textContent).toContain("Requested Oct 1 · waiting");
    expect(document.body.textContent).toMatch(/Estimate \$180/);
    expect(document.body.textContent).toMatch(/Bid \$200 \+ \$25 materials/);
    // This vendor's own number: bid total over estimate; no row for the service someone else won.
    expect(screen.getAllByText("$225").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$180").length).toBeGreaterThan(0);
    expect(screen.queryByText("Lost to another vendor")).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: /^Assigned/ })[0]!);
    await waitFor(() => expect(screen.getByText("Filter swap")).toBeTruthy());
    expect(document.body.textContent).toContain("Pacific Plumbing · no time yet");
    fireEvent.click(screen.getAllByRole("button", { name: /^Scheduled/ })[0]!);
    await waitFor(() => expect(screen.getByText("Re-pipe")).toBeTruthy());
    expect(screen.getAllByText("$300").length).toBeGreaterThan(0);
    expect(read("src/components/portal/vendor-record-services-tab.tsx")).not.toMatch(/<Badge\b/);
  });
});

describe("Outgoing payments tab", () => {
  it("asks for this vendor record, not the login, so a vendor with no linked account still lists its payments", async () => {
    outgoing = { invoices: [bill("inv-open", "approved"), bill("inv-sched", "scheduled", { scheduledFor: "2099-01-01" }), bill("inv-paid", "paid", { paidAt: "2026-09-11T12:00:00.000Z" })], payouts: [] };
    renderDetail("invoices", vendor({ vendorUserId: undefined }));
    await waitFor(() => expect(document.querySelectorAll('[data-attr="outgoing-invoice-row"]').length).toBe(1));
    const call = fetched.find((url) => url.startsWith("/api/manager/vendor-invoices?status"))!;
    expect(call).toContain("vendorId=v-1");
    expect(call).not.toContain("vendorUserId");
    expect(tabCount("To pay")).toMatch(/To pay\s*1/);
    expect(tabCount("Scheduled")).toMatch(/Scheduled\s*1/);
    expect(tabCount("Paid")).toMatch(/Paid\s*1/);
    expect(screen.getAllByText("$125.00").length).toBeGreaterThan(0);
    expect(screen.queryByText(/linked vendor account/i)).toBeNull();
    // Filing a new bill needs a login to bill against; there is no round + for this record.
    expect(screen.queryByRole("button", { name: /^Add payment$|^Pay vendor$/ })).toBeNull();
  });

  it("shows the standard empty card 'No payments to <vendor> yet' when there are none", async () => {
    renderDetail("invoices", vendor({ vendorUserId: undefined }));
    await waitFor(() => expect(screen.getByText("No payments to Pacific Plumbing yet")).toBeTruthy());
    expect(document.querySelector('[data-attr="portal-list-empty-card"]')).not.toBeNull();
    expect(screen.queryByText(/linked vendor account/i)).toBeNull();
  });

  it("offers the round + for a vendor with a linked login", async () => {
    renderDetail("invoices", vendor({ vendorUserId: "login-1" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Add payment" })).toBeTruthy());
  });
});

describe("Communication tab", () => {
  it("uses the shared record Communication section for this vendor's contact", () => {
    renderDetail("communication");
    const section = document.querySelector('[data-attr="mock-record-communication"]')!;
    expect(section.getAttribute("data-kind")).toBe("vendor");
    expect(section.getAttribute("data-id")).toBe("v-1");
    expect(section.getAttribute("data-contact")).toBe("hello@pacific.test");
    expect(section.getAttribute("data-fill")).toBe("true");
    expect(read("src/components/portal/pro-vendor-detail.tsx")).not.toContain("ManagerInbox");
  });
});

describe("vendor record header icons", () => {
  const sections = recordSections("manager", "vendor", { basePath: "/portal" });

  it("are Edit · Invite · Message · Remove (no Text), with Remove last and destructive", () => {
    expect(sections.headerActions.map((a) => [a.id, a.label])).toEqual([
      ["edit", "Edit vendor"],
      ["invite", "Invite to PropLane"],
      ["message", "Message"],
      ["remove", "Remove vendor"],
    ]);
    expect(sections.headerActions.at(-1)!.tone).toBe("danger");
  });

  it("render as labelled icon actions with Message as the one filled primary", () => {
    const onAction = vi.fn();
    render(<PortalRecordHeaderIconActions actions={sections.headerActions} onAction={onAction} primaryId="message" />);
    for (const label of ["Edit vendor", "Invite to PropLane", "Message", "Remove vendor"]) {
      const button = screen.getAllByLabelText(label)[0]!;
      // The label is the accessible name; the hover tooltip is a portaled pill, not a native title.
      expect(button.getAttribute("aria-label")).toBe(label);
      expect(button.getAttribute("title")).toBeNull();
    }
    const filled = [...document.querySelectorAll<HTMLButtonElement>('[data-slot="portal-icon-action"]')].filter((el) => el.className.includes("bg-[var(--btn-primary)]"));
    expect([...new Set(filled.map((el) => el.getAttribute("aria-label")))]).toEqual(["Message"]);
    const remove = screen.getAllByLabelText("Remove vendor")[0]!;
    expect(remove.className).toContain("text-red-600");
    fireEvent.click(remove);
    expect(onAction).toHaveBeenCalledWith("remove");
  });

  it("uses the clearer glyphs: Send for Message, UserPlus for Invite, Trash2 for Remove (not a person-minus)", () => {
    const source = read("src/lib/portals/record-sections.ts");
    const block = source.slice(source.indexOf("// Edit · Invite · Message · Remove."), source.indexOf("hasDocuments: false", source.indexOf("// Edit · Invite · Message · Remove.")));
    expect(block).toContain('icon: Send, tone: "primary"');
    expect(block).toContain("icon: UserPlus");
    expect(block).toContain('icon: Trash2, tone: "danger"');
    expect(block).not.toContain("UserMinus");
  });

  it("the vendor page fills Message, relabels Invite as Resend once invited, and confirms Remove in a preview", () => {
    const panel = read("src/components/portal/pro-vendors-panel.tsx");
    expect(panel).toContain('primaryId="message"');
    expect(panel).toContain('"Resend invite"');
    expect(panel).toContain("openVendorRemovePreview([routeVendor])");
    expect(panel).toContain('title="Remove vendor — notification preview"');
  });
});

describe("vendor record list tabs share the standard band", () => {
  it("Services opens with the band: Open · Assigned · Scheduled · Completed, search and the round +, empty card under it", async () => {
    renderDetail("services");
    await waitFor(() => expect(document.querySelector('[data-attr="portal-list-empty-card"]')).not.toBeNull());
    const band = document.querySelector('[data-attr="vendor-services-list"]')!;
    expect([...band.querySelectorAll('[data-attr^="vendor-services-list-tab-"]')].map((b) => (b.textContent ?? "").replace(/\s*\d+$/, ""))).toEqual(["Open", "Assigned", "Scheduled", "Completed"]);
    expect(screen.getByPlaceholderText("Search services")).toBeTruthy();
    expect(document.querySelector('[data-attr="vendor-services-add"]')).not.toBeNull();
    expect(band.firstElementChild!.contains(screen.getByPlaceholderText("Search services"))).toBe(true);
  });

  it("Outgoing payments opens with the band: To pay · Scheduled · Paid and search", async () => {
    renderDetail("invoices", vendor({ vendorUserId: undefined }));
    await waitFor(() => expect(screen.getByText("No payments to Pacific Plumbing yet")).toBeTruthy());
    expect(screen.getByPlaceholderText("Search outgoing payments")).toBeTruthy();
    for (const label of ["To pay", "Scheduled", "Paid"]) expect(tabCount(label)).toMatch(new RegExp(`${label}\\s*0`));
  });
});
