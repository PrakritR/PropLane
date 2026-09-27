// @vitest-environment jsdom
/**
 * C260: the "Pay vendors" card lists approved invoices with a per-invoice
 * "Pay from balance" and a bulk "Pay all approved" once more than one is
 * outstanding — both call the SAME existing per-invoice
 * `POST /api/vendor/invoices/[id]/pay-from-balance` route, never a batch
 * endpoint. C106 is the same per-invoice button; the shortfall case shows an
 * honest inline message rather than a fabricated ACH fallback (see the
 * component's own doc comment for why).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const showToast = vi.fn();
vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast }),
}));

import { PayVendorsCard } from "@/components/portal/finances/pay-vendors-card";

type MockInvoice = { id: string; vendorName: string; invoiceNumber: string | null; totalCents: number };

function mockFetch(invoices: MockInvoice[], payResults: Record<string, { ok: boolean; status?: number; body?: unknown }>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.startsWith("/api/manager/vendor-invoices")) {
        return Response.json({ invoices });
      }
      const payMatch = url.match(/^\/api\/vendor\/invoices\/([^/]+)\/pay-from-balance$/);
      if (payMatch) {
        const id = decodeURIComponent(payMatch[1]!);
        const result = payResults[id] ?? { ok: true };
        return new Response(JSON.stringify(result.body ?? (result.ok ? { invoice: { id } } : { error: "failed" })), {
          status: result.status ?? (result.ok ? 200 : 500),
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  showToast.mockClear();
});

describe("PayVendorsCard (C260 / C106)", () => {
  it("shows an empty state with no approved invoices", async () => {
    mockFetch([], {});
    render(<PayVendorsCard availableCents={10_000} />);
    await waitFor(() =>
      expect(document.querySelector('[data-attr="finances-pay-vendors-empty"]')).toBeTruthy(),
    );
  });

  it("pays a single invoice through the existing per-invoice route, then refreshes the list", async () => {
    const invoice: MockInvoice = { id: "inv-1", vendorName: "Acme Plumbing", invoiceNumber: "INV-100", totalCents: 5_000 };
    let first = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("/api/manager/vendor-invoices")) {
          return Response.json({ invoices: first ? [invoice] : [] });
        }
        if (url === "/api/vendor/invoices/inv-1/pay-from-balance" && init?.method === "POST") {
          first = false;
          return Response.json({ invoice: { ...invoice, status: "paid" } });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    render(<PayVendorsCard availableCents={10_000} />);
    await waitFor(() => expect(screen.getByText("Acme Plumbing")).toBeTruthy());

    fireEvent.click(screen.getByText("Pay from balance"));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Paid from your PropLane balance."));
    await waitFor(() =>
      expect(document.querySelector('[data-attr="finances-pay-vendors-empty"]')).toBeTruthy(),
    );
  });

  it("shows the exact shortfall instead of a Pay button when the balance can't cover an invoice", async () => {
    const invoice: MockInvoice = { id: "inv-2", vendorName: "Big Roofing", invoiceNumber: null, totalCents: 20_000 };
    mockFetch([invoice], {});

    render(<PayVendorsCard availableCents={5_000} />);
    await waitFor(() => expect(screen.getByText("Big Roofing")).toBeTruthy());

    expect(screen.queryByText("Pay from balance")).toBeNull();
    expect(document.querySelector('[data-attr="finances-pay-vendors-shortfall"]')?.textContent).toContain(
      "$150.00",
    );
  });

  it("has no bulk action for a single invoice, but shows one once more than one is outstanding", async () => {
    mockFetch(
      [{ id: "inv-3", vendorName: "Solo Vendor", invoiceNumber: null, totalCents: 1_000 }],
      {},
    );
    render(<PayVendorsCard availableCents={10_000} />);
    await waitFor(() => expect(screen.getByText("Solo Vendor")).toBeTruthy());
    expect(document.querySelector('[data-attr="finances-pay-vendors-pay-all"]')).toBeNull();
  });

  it("Pay all approved pays only the invoices the running balance can cover, sequentially, per invoice", async () => {
    const fits: MockInvoice = { id: "fits", vendorName: "Fits Vendor", invoiceNumber: null, totalCents: 3_000 };
    const tooBig: MockInvoice = { id: "too-big", vendorName: "Too Big Vendor", invoiceNumber: null, totalCents: 9_000 };
    const paidIds: string[] = [];
    let listCallCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("/api/manager/vendor-invoices")) {
          listCallCount += 1;
          // After the bulk pass, "fits" is gone (paid), "too-big" remains.
          return Response.json({ invoices: listCallCount === 1 ? [fits, tooBig] : [tooBig] });
        }
        const payMatch = url.match(/^\/api\/vendor\/invoices\/([^/]+)\/pay-from-balance$/);
        if (payMatch && init?.method === "POST") {
          const id = decodeURIComponent(payMatch[1]!);
          paidIds.push(id);
          return Response.json({ invoice: { id, status: "paid" } });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    render(<PayVendorsCard availableCents={5_000} />);
    await waitFor(() => expect(screen.getByText("Fits Vendor")).toBeTruthy());

    fireEvent.click(screen.getByText("Pay all approved"));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Paid 1 invoice from balance."));
    // Only the invoice the 5,000-cent balance could actually cover was paid —
    // never the too-big one, and never a batch call.
    expect(paidIds).toEqual(["fits"]);
  });
});
