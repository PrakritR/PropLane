// @vitest-environment jsdom
//
// PRP-254 #1 — a vendor working for two managers could never submit an invoice.
//
// `prepareVendorInvoiceSubmission` refuses to guess which client is being billed when the
// vendor has several linked managers, which is correct — but the submit form never sent
// `managerUserId` and there was no picker, so that refusal was unreachable to satisfy. Serving
// several clients is the normal condition for a contractor, so this blocked the base case.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { VendorFinancesPanel } from "@/components/portal/vendor-finances-panel";

const state = vi.hoisted(() => ({
  managers: [] as { managerUserId: string; label: string }[],
  posted: [] as Record<string, unknown>[],
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/vendor/finances/invoices",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock("@/lib/vendor-payouts", () => ({
  fetchVendorPayoutsResult: async () => ({ ok: true, payouts: [] }),
}));

vi.mock("@/lib/manager-work-orders-storage", () => ({
  MANAGER_WORK_ORDERS_EVENT: "manager-work-orders",
  readVendorWorkOrderRows: () => [],
  syncManagerWorkOrdersFromServer: async () => {},
}));

beforeEach(() => {
  state.posted = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
      if (String(url).includes("/api/vendor/invoices") && init?.method === "POST") {
        state.posted.push(JSON.parse(init.body ?? "{}"));
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ invoices: [], linkedManagers: state.managers }),
      } as unknown as Response;
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderInvoices() {
  return render(<VendorFinancesPanel tabId="invoices" />);
}

async function openSubmitModal() {
  await waitFor(() => expect(document.querySelector('[data-attr="vendor-invoice-new"]')).toBeTruthy());
  fireEvent.click(document.querySelector('[data-attr="vendor-invoice-new"]') as HTMLElement);
}

function picker(): HTMLSelectElement | null {
  return document.querySelector('[data-attr="vendor-invoice-manager"]');
}

describe("vendor invoice manager picker", () => {
  it("asks which manager to bill when the vendor serves more than one", async () => {
    state.managers = [
      { managerUserId: "mgr-a", label: "Alex Manager" },
      { managerUserId: "mgr-b", label: "Blair Manager" },
    ];
    renderInvoices();
    await openSubmitModal();

    await waitFor(() => expect(picker()).toBeTruthy());
    expect(screen.getByText("Alex Manager")).toBeTruthy();
    expect(screen.getByText("Blair Manager")).toBeTruthy();
  });

  it("does not ask when there is only one manager to bill", async () => {
    state.managers = [{ managerUserId: "mgr-a", label: "Alex Manager" }];
    renderInvoices();
    await openSubmitModal();

    await waitFor(() => expect(screen.queryByText(/line items/i)).toBeTruthy());
    expect(picker()).toBeNull();
  });

  it("sends the chosen manager with the invoice", async () => {
    state.managers = [
      { managerUserId: "mgr-a", label: "Alex Manager" },
      { managerUserId: "mgr-b", label: "Blair Manager" },
    ];
    renderInvoices();
    await openSubmitModal();
    await waitFor(() => expect(picker()).toBeTruthy());

    fireEvent.change(picker()!, { target: { value: "mgr-b" } });
    fireEvent.change(screen.getByPlaceholderText("Description"), { target: { value: "Labor" } });
    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Unit amount in dollars"), { target: { value: "100" } });
    fireEvent.click(document.querySelector('[data-attr="vendor-invoice-submit"]') as HTMLElement);

    await waitFor(() => expect(state.posted).toHaveLength(1));
    expect(state.posted[0]?.managerUserId).toBe("mgr-b");
  });

  it("refuses to submit without a choice rather than billing an arbitrary client", async () => {
    state.managers = [
      { managerUserId: "mgr-a", label: "Alex Manager" },
      { managerUserId: "mgr-b", label: "Blair Manager" },
    ];
    renderInvoices();
    await openSubmitModal();
    await waitFor(() => expect(picker()).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText("Description"), { target: { value: "Labor" } });
    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Unit amount in dollars"), { target: { value: "100" } });
    fireEvent.click(document.querySelector('[data-attr="vendor-invoice-submit"]') as HTMLElement);

    await waitFor(() => expect(screen.getByText(/choose which manager/i)).toBeTruthy());
    expect(state.posted).toHaveLength(0);
  });
});
