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
  RecordCommunicationSection: (props: { recordRef: { kind: string; id: string }; contactIds?: string[] }) => (
    <div data-attr="mock-record-communication" data-kind={props.recordRef.kind} data-id={props.recordRef.id} data-contact={(props.contactIds ?? []).join(",")} />
  ),
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
  summaryState.value = { jobs: [], totalJobCount: 0, ratingCount: 0, ratingAverage: null, completedJobCount: 0, completedInvoiceTotalCents: null, completedInvoiceAverageCents: null };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    fetched.push(String(url));
    const u = String(url);
    const body = u.startsWith("/api/manager/vendor-invoices?status")
      ? { ...outgoing, totals: { owedCents: 0, paidThisYearCents: 0 } }
      : u.startsWith("/api/portal/vendor-reviews")
        ? { reviews, aggregate: { average: null, count: reviews.length } }
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
  it("is one header card with Reviews <n>, the round + and one standard empty card, with no subtext sentences", async () => {
    renderDetail("reviews");
    await waitFor(() => expect(document.querySelector('[data-attr="portal-list-empty-card"]')).not.toBeNull());
    expect(tabCount("Reviews")).toMatch(/Reviews\s*0/);
    expect(tabCount("Resident ratings")).toMatch(/Resident ratings\s*0/);
    expect(screen.getByRole("button", { name: "Add review" })).toBeTruthy();
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
    expect(tabCount("Reviews")).toMatch(/Reviews\s*1/);
    fireEvent.click(screen.getAllByRole("button", { name: /^Resident ratings/ })[0]!);
    await waitFor(() => expect(document.querySelectorAll('[data-attr="vendor-resident-rating-row"]').length).toBe(1));
    expect(screen.getByText("Resident rating")).toBeTruthy();
    expect(screen.getAllByText("5 / 5").length).toBeGreaterThan(0);
  });

  it("source carries no explanatory sentence under the heading", () => {
    const source = read("src/components/portal/pro-vendor-detail.tsx");
    expect(source).not.toContain("No reviews from PropLane managers yet.");
    expect(source).not.toContain("No completed-service ratings from your portfolio yet.");
  });
});

describe("Services tab", () => {
  it("shows Open / Done with counts and the standard empty card when empty", async () => {
    renderDetail("services");
    await waitFor(() => expect(document.querySelector('[data-attr="portal-list-empty-card"]')).not.toBeNull());
    expect(tabCount("Open")).toMatch(/Open\s*0/);
    expect(tabCount("Done")).toMatch(/Done\s*0/);
    expect(screen.getByText("No open services with Pacific Plumbing")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Add service" }).length).toBeGreaterThan(0);
  });

  it("renders each service through the shared Services card row", async () => {
    summaryState.value = { ...summaryState.value, jobs: [
      { id: "wo-1", title: "Burst pipe", propertyName: "Alder House", unit: "2B", status: "open", acceptedQuoteCents: null, finalInvoiceCents: 12500, paidCents: null, residentRating: null },
    ] };
    renderDetail("services");
    await waitFor(() => expect(document.querySelectorAll('[data-attr="vendor-service-row"]').length).toBe(1));
    expect(screen.getAllByText("$125.00").length).toBeGreaterThan(0);
    expect(read("src/components/portal/pro-vendor-detail.tsx")).toContain("ManagerServiceCardRow");
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
    expect(read("src/components/portal/pro-vendor-detail.tsx")).not.toContain("ManagerInbox");
  });
});

describe("vendor record header icons", () => {
  const sections = recordSections("manager", "vendor", { basePath: "/portal" });

  it("are Edit · Invite · Message · Remove, with Remove last and destructive", () => {
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
      expect(button.getAttribute("title")).toBe(label);
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
