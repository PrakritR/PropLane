// @vitest-environment jsdom
//
// PRP-254 #1 — a vendor working for two managers could never submit an invoice.
//
// `prepareVendorInvoiceSubmission` refuses to guess which client is being billed when the
// vendor has several linked managers, which is correct — but the submit form never sent
// `managerUserId` and there was no picker, so that refusal was unreachable to satisfy. Serving
// several clients is the normal condition for a contractor, so this blocked the base case.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { VendorFinancesPanel } from "@/components/portal/vendor-finances-panel";

const state = vi.hoisted(() => ({
  managers: [] as { managerUserId: string; label: string }[],
  posted: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/demo/demo-session", () => ({
  isDemoModeActive: () => false,
  subscribeDemoPath: () => () => {},
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
  return render(
    <AppUiProvider>
      <VendorFinancesPanel tabId="invoices" />
    </AppUiProvider>,
  );
}

async function openRequestPayment() {
  await waitFor(() => expect(document.querySelector('[data-attr="vendor-invoice-new"]')).toBeTruthy());
  fireEvent.click(document.querySelector('[data-attr="vendor-invoice-new"]') as HTMLElement);
}

async function goToInvoiceStep() {
  await openRequestPayment();
  await waitFor(() => expect(document.querySelector('[data-attr="vendor-quote-wizard-next"]')).toBeTruthy());
  fireEvent.click(document.querySelector('[data-attr="vendor-quote-wizard-next"]') as HTMLElement);
  await waitFor(() => expect(screen.getByLabelText("Amount")).toBeTruthy());
}

/** The Bill-to control is the PropLane dropdown: a button that opens a portaled listbox. */
function picker(): HTMLButtonElement | null {
  return document.querySelector('[data-attr="vendor-invoice-manager"]');
}

function openPicker(): HTMLElement {
  const trigger = picker()!;
  fireEvent.click(trigger);
  return document.getElementById(trigger.getAttribute("aria-controls")!)!;
}

function pickManager(managerUserId: string) {
  const option = openPicker().querySelector(`[data-field-select-option-value="${managerUserId}"]`)!;
  fireEvent.pointerDown(option, { pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(option, { pointerId: 1, clientX: 10, clientY: 10 });
}

describe("vendor invoice manager picker", () => {
  it("asks which manager to bill when the vendor serves more than one", async () => {
    state.managers = [
      { managerUserId: "mgr-a", label: "Alex Manager" },
      { managerUserId: "mgr-b", label: "Blair Manager" },
    ];
    renderInvoices();
    await goToInvoiceStep();

    await waitFor(() => expect(picker()).toBeTruthy());
    const listbox = openPicker();
    expect(within(listbox).getByText("Alex Manager")).toBeTruthy();
    expect(within(listbox).getByText("Blair Manager")).toBeTruthy();
  });

  it("does not ask when there is only one manager to bill", async () => {
    state.managers = [{ managerUserId: "mgr-a", label: "Alex Manager" }];
    renderInvoices();
    await goToInvoiceStep();

    await waitFor(() => expect(screen.getByLabelText("Amount")).toBeTruthy());
    expect(picker()).toBeNull();
  });

  it("sends the chosen manager with the invoice", async () => {
    state.managers = [
      { managerUserId: "mgr-a", label: "Alex Manager" },
      { managerUserId: "mgr-b", label: "Blair Manager" },
    ];
    renderInvoices();
    await goToInvoiceStep();
    await waitFor(() => expect(picker()).toBeTruthy());

    pickManager("mgr-b");
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "100" } });
    fireEvent.click(document.querySelector('[data-attr="vendor-quote-wizard-next"]') as HTMLElement);
    await waitFor(() => expect(document.querySelector('[data-attr="vendor-invoice-submit"]')).toBeTruthy());
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
    await goToInvoiceStep();
    await waitFor(() => expect(picker()).toBeTruthy());

    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "100" } });
    fireEvent.click(document.querySelector('[data-attr="vendor-quote-wizard-next"]') as HTMLElement);
    await waitFor(() => expect(document.querySelector('[data-attr="vendor-invoice-submit"]')).toBeTruthy());
    fireEvent.click(document.querySelector('[data-attr="vendor-invoice-submit"]') as HTMLElement);

    await waitFor(() => expect(screen.getByText(/choose which manager/i)).toBeTruthy());
    expect(state.posted).toHaveLength(0);
  });
});
