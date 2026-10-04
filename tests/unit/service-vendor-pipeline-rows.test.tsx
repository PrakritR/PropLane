// @vitest-environment jsdom
// The Vendors section rows are the Vendors list's rows (tile, name, trade, glyph facts, ⋯): no checkbox, no sticky
// send bar, no sentence about what vendors see. What a row can do is in its ⋯; the round + opens the Send job popup.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import type { WorkOrderBid } from "@/lib/work-order-bids";
import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { ServiceVendorPipeline } from "@/components/portal/service-vendor-cycle-section";
import { buildServicePipeline } from "@/lib/service-pipeline";

vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/services/work-orders/open/wo-1/vendors",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

afterEach(() => cleanup());

const job = (over: Partial<DemoManagerWorkOrderRow> = {}): DemoManagerWorkOrderRow => ({
  id: "wo-1", propertyName: "Alder House", unit: "2B", title: "Faucet", priority: "Medium", status: "Open", bucket: "open", description: "", scheduled: "", cost: "", ...over,
});
const accepted: WorkOrderBid = {
  id: "b-1", workOrderId: "wo-1", vendorUserId: "u-9", vendorDirectoryId: "v-9", vendorName: "Pacific Plumbing", quoteMode: "upfront",
  consultationVisitAt: null, amountCents: 14_000, materialsCents: 0, proposedTime: "2026-10-08T16:00:00.000Z", note: null, status: "accepted",
  createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z", bidSubmittedAt: "2026-10-02T00:00:00.000Z",
};
const roster = [
  ...Array.from({ length: 12 }, (_, i) => ({ id: `r-${i}`, name: `Vendor ${String(i).padStart(2, "0")}`, trade: "Plumbing", active: true })),
  { id: "v-9", name: "Pacific Plumbing", trade: "Plumbing", active: true },
];

const handlers = () => ({
  sending: false,
  approvingBidId: null,
  onSend: vi.fn(),
  onWithdraw: vi.fn(),
  onApprove: vi.fn(),
  onSchedule: vi.fn(),
  onMarkDone: vi.fn(),
  onPay: vi.fn(),
  onOpenVendor: vi.fn(),
});

async function itemsOf(name: string): Promise<string[]> {
  fireEvent.keyDown(screen.getByRole("button", { name: `Actions for ${name}` }), { key: "ArrowDown" });
  const menu = await screen.findByRole("menu");
  return [...menu.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent ?? "");
}

describe("Vendors rows: what each tab's ⋯ holds", () => {
  it("Scheduled: Reschedule, Mark done, Open vendor - and clicking them calls the host", async () => {
    const h = handlers();
    const pipeline = buildServicePipeline({ job: job(), offers: [], bids: [accepted], roster, jobTrade: "Plumbing" });
    render(<AppUiProvider><ServiceVendorPipeline pipeline={pipeline} trade="Plumbing" {...h} /></AppUiProvider>);
    // Opens on Scheduled: the approved vendor, with its visit and the bid's amount as plain facts.
    expect(document.querySelectorAll('[data-attr="service-pipeline-scheduled-row"]').length).toBe(1);
    expect(document.body.textContent).toContain("$140");
    expect(await itemsOf("Pacific Plumbing")).toEqual(["Reschedule", "Mark done", "Open vendor"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Mark done" }));
    expect(h.onMarkDone).toHaveBeenCalledTimes(1);
  });

  it("Done: Pay only while it is owed, then Open vendor", async () => {
    const h = handlers();
    const done = job({ bucket: "completed", status: "Completed", automationStatus: "vendor_marked_done", vendorId: "v-9", vendorName: "Pacific Plumbing" });
    const pipeline = buildServicePipeline({ job: done, offers: [], bids: [accepted], roster, jobTrade: "Plumbing" });
    render(<AppUiProvider><ServiceVendorPipeline pipeline={pipeline} trade="Plumbing" {...h} /></AppUiProvider>);
    expect(await itemsOf("Pacific Plumbing")).toEqual(["Pay", "Open vendor"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Pay" }));
    expect(h.onPay).toHaveBeenCalledTimes(1);
  });

  it("Open vendor opens that vendor's record", async () => {
    const h = handlers();
    const pipeline = buildServicePipeline({ job: job(), offers: [], bids: [accepted], roster, jobTrade: "Plumbing" });
    render(<AppUiProvider><ServiceVendorPipeline pipeline={pipeline} trade="Plumbing" {...h} /></AppUiProvider>);
    await itemsOf("Pacific Plumbing");
    fireEvent.click(screen.getByRole("menuitem", { name: "Open vendor" }));
    expect(h.onOpenVendor).toHaveBeenCalledWith("v-9", "Pacific Plumbing");
  });

  it("no row carries an inline button or a checkbox, and a vendor with no roster record has no Open vendor", async () => {
    const h = handlers();
    const pipeline = buildServicePipeline({ job: job(), offers: [], bids: [], roster, jobTrade: "Plumbing" });
    render(<AppUiProvider><ServiceVendorPipeline pipeline={pipeline} trade="Plumbing" {...h} /></AppUiProvider>);
    const rows = [...document.querySelectorAll('[data-attr="service-pipeline-available-row"]')];
    expect(rows.length).toBe(13);
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
    expect(document.querySelector('[data-attr="service-send-bar"]')).toBeNull();
    expect(await itemsOf("Vendor 00")).toEqual(["Send job", "Open vendor"]);
  });
});

describe("the Send job popup", () => {
  it("a row's Send job opens it with that vendor chosen; Send hands the host the ids", async () => {
    const h = handlers();
    const pipeline = buildServicePipeline({ job: job(), offers: [], bids: [], roster, jobTrade: "Plumbing" });
    render(<AppUiProvider><ServiceVendorPipeline pipeline={pipeline} trade="Plumbing" {...h} /></AppUiProvider>);
    await itemsOf("Vendor 03");
    fireEvent.click(screen.getByRole("menuitem", { name: "Send job" }));
    const finish = (await waitFor(() => document.querySelector('[data-attr="service-send-job"]'))) as HTMLButtonElement;
    expect(finish.textContent).toBe("Send job to 1");
    fireEvent.click(finish);
    await waitFor(() => expect(h.onSend).toHaveBeenCalledWith(["r-3"], undefined));
  });

  it("the round + opens it: vendors come from a dropdown capped at ten, and the PropLane reach has 5 / 10 / 25 mi", async () => {
    const h = handlers();
    const pipeline = buildServicePipeline({ job: job(), offers: [], bids: [], roster, jobTrade: "Plumbing" });
    render(<AppUiProvider><ServiceVendorPipeline pipeline={pipeline} trade="Plumbing" {...h} /></AppUiProvider>);
    fireEvent.click(document.querySelector('[data-attr="service-send-plus"]') as HTMLElement);
    const finish = (await waitFor(() => document.querySelector('[data-attr="service-send-job"]'))) as HTMLButtonElement;
    expect(finish.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Vendors/ }));
    const list = await screen.findByRole("listbox", { name: "Vendors" });
    for (const option of within(list).getAllByRole("option").slice(0, 12)) fireEvent.click(option);
    expect(finish.textContent).toBe("Send job to 10");
    // The marketplace reach is a switch (not a checkbox) with a radius dropdown.
    const toggle = screen.getByRole("switch", { name: /PropLane vendors within/ });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "Marketplace radius" }));
    const radii = within(await screen.findByRole("listbox", { name: "Marketplace radius" })).getAllByRole("option").map((o) => o.textContent);
    expect(radii).toEqual(["5 mi", "10 mi", "25 mi"]);
    fireEvent.click(screen.getByRole("option", { name: "25 mi" }));
    fireEvent.click(finish);
    await waitFor(() => expect(h.onSend).toHaveBeenCalledTimes(1));
    const [ids, marketplace] = h.onSend.mock.calls[0]!;
    expect(ids).toHaveLength(10);
    expect(marketplace).toEqual({ enabled: true, trade: "Plumbing", radiusMi: 25 });
  });
});

describe("the Vendors section source", () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
  it("has no checkbox, no sticky send bar and no privacy sentence", () => {
    for (const file of ["service-vendor-cycle-section.tsx", "service-send-job-popup.tsx", "service-who-card.tsx", "service-details-section.tsx"]) {
      const src = read(`src/components/portal/${file}`);
      expect(src, file).not.toMatch(/type="checkbox"/);
      expect(src, file).not.toContain("service-send-bar");
      expect(src, file).not.toContain("PIPELINE_PRIVACY_LINE");
      expect(src, file).not.toContain("Vendors see the general area only");
    }
  });
});
